import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  listFeedsForSource,
  softDeleteFeed,
} from "../../src/repositories/feed-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  type SubstackPublicationProbe,
  SubstackPublicationService,
} from "../../src/services/substack-publication-service.ts";
import { ConflictError, ValidationError } from "../../src/server/errors.ts";

function cipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(29)),
  );
}

function userInput(email: string) {
  return {
    name: "Publication Reader",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

async function connectedSubstackSource(
  database: Parameters<typeof createSource>[0],
  userId: string,
) {
  const credentials = await cipher().encrypt(
    JSON.stringify({
      substackSessionId: "s%3Asubstack.signature",
      connectSessionId: "s%3Aconnect.signature",
    }),
    { userId, connectorId: ConnectorId.Substack },
  );
  return await createSource(database, {
    userId,
    connectorId: ConnectorId.Substack,
    credentials,
  });
}

test("SubstackPublicationService probes then creates one canonical feed", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("publication-add@example.com"),
    );
    const source = await connectedSubstackSource(database, user.id);
    const requested: string[] = [];
    const probe: SubstackPublicationProbe = (publicationUrl) => {
      requested.push(publicationUrl);
      return Promise.resolve({
        origin: "https://newsletter.example.com",
        items: [{
          id: 101,
          publicationId: 9,
          type: "newsletter",
          title: "Article",
          postDate: Date.now(),
          publicationName: "Example Letter",
          raw: {},
        }],
      });
    };
    const service = new SubstackPublicationService(database, probe);
    const first = await service.add(
      user.id,
      "https://example.substack.com/feed",
    );
    const duplicate = await service.add(
      user.id,
      "https://newsletter.example.com/p/article",
    );
    assertEquals(requested, [
      "https://example.substack.com/feed",
      "https://newsletter.example.com/p/article",
    ]);
    assertEquals(first.source.id, source.id);
    assertEquals(first.feed.externalId, "https://newsletter.example.com");
    assertEquals(first.feed.name, "Example Letter");
    assertEquals(first.feed.kind, "news");
    assertEquals(duplicate.feed.id, first.feed.id);
  });
});

test("SubstackPublicationService accepts empty archives and revives deleted feeds", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("publication-revive@example.com"),
    );
    const source = await connectedSubstackSource(database, user.id);
    const probe: SubstackPublicationProbe = () =>
      Promise.resolve({
        origin: "https://empty.example.com",
        items: [],
      });
    const service = new SubstackPublicationService(database, probe);
    const created = await service.add(user.id, "https://empty.example.com");
    assertEquals(created.feed.name, "empty.example.com");
    await softDeleteFeed(database, created.feed.id, user.id);
    const revived = await service.add(user.id, "https://empty.example.com");
    assertEquals(revived.feed.id, created.feed.id);
    assertEquals(revived.feed.deletedAt, null);
    assertEquals(
      (await listFeedsForSource(database, source.id, user.id)).length,
      1,
    );
  });
});

test("SubstackPublicationService requires a connected owned source and writes nothing on probe failure", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("publication-failure@example.com"),
    );
    const otherUser = await createUser(
      database,
      userInput("publication-other@example.com"),
    );
    const source = await connectedSubstackSource(database, user.id);
    const failingProbe: SubstackPublicationProbe = () =>
      Promise.reject(new Error("private resolver details"));
    const service = new SubstackPublicationService(database, failingProbe);
    await assertRejects(
      () => service.add(user.id, "https://example.com"),
      ValidationError,
      "Substack publication could not be validated",
    );
    assertEquals(await listFeedsForSource(database, source.id, user.id), []);
    await assertRejects(
      () => service.add(otherUser.id, "https://example.com"),
      ConflictError,
      "Connect your Substack session first",
    );
  });
});

test("SubstackPublicationService does not persist after its signal is aborted", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("publication-aborted@example.com"),
    );
    const source = await connectedSubstackSource(database, user.id);
    const controller = new AbortController();
    const probe: SubstackPublicationProbe = () => {
      controller.abort();
      return Promise.resolve({
        origin: "https://aborted.example.com",
        items: [],
      });
    };
    const service = new SubstackPublicationService(database, probe);
    await assertRejects(
      () =>
        service.add(user.id, "https://aborted.example.com", controller.signal),
      ValidationError,
      "Substack publication could not be validated",
    );
    assertEquals(await listFeedsForSource(database, source.id, user.id), []);
  });
});
