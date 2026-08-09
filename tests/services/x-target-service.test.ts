import { test } from "bun:test";

import type { AvailableFeed } from "../../src/connectors/connector.types.ts";
import { MAX_X_FEEDS } from "../../src/connectors/x/index.ts";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import type { Database } from "../../src/db/client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { listFeedsForSource } from "../../src/repositories/feed-repository.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/server/errors.ts";
import {
  type XTargetBrowserRuntime,
  XTargetService,
} from "../../src/services/x-target-service.ts";
import {
  assertEquals,
  assertRejects,
} from "../assertions.ts";

const MASTER_KEY = new Uint8Array(32).fill(61);

class FakeXTargetRuntime implements XTargetBrowserRuntime {
  readonly calls: Array<{
    profileId: string;
    url: string;
    signal: AbortSignal | null;
  }> = [];
  result: AvailableFeed = {
    externalId: "x:list:123",
    name: "Research",
    kind: "news",
  };

  resolveTarget(
    profileId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<AvailableFeed> {
    this.calls.push({ profileId, url, signal: signal ?? null });
    return Promise.resolve(this.result);
  }
}

async function fixtureUser(database: Database, email: string): Promise<{ id: string }> {
  return await createUser(database, {
    name: "X Target User",
    email,
    passwordHash: null,
    systemPrompt: "Summarize tersely.",
  });
}

async function fixtureXSource(
  database: Database,
  cipher: CredentialCipher,
  userId: string,
  profileId = userId,
): Promise<{ id: string }> {
  const credentials = await cipher.encrypt(JSON.stringify({ profileId }), {
    userId,
    connectorId: ConnectorId.X,
  });
  return await createSource(database, {
    userId,
    connectorId: ConnectorId.X,
    credentials,
  });
}

test("X target addition is owner-scoped and forwards one canonical target with its signal", async () => {
  await withTestDb(async (database) => {
    const cipher = new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY));
    const owner = await fixtureUser(database, "x-target-owner@example.com");
    const stranger = await fixtureUser(database, "x-target-stranger@example.com");
    const source = await fixtureXSource(database, cipher, owner.id);
    const runtime = new FakeXTargetRuntime();
    const service = new XTargetService({
      database,
      credentialCipher: cipher,
      browserRuntime: runtime,
    });
    const controller = new AbortController();

    const added = await service.add(
      owner.id,
      source.id,
      "https://x.com/i/lists/123",
      controller.signal,
    );
    assertEquals({
      sourceId: added.sourceId,
      externalId: added.externalId,
      name: added.name,
      kind: added.kind,
    }, {
      sourceId: source.id,
      ...runtime.result,
    });
    assertEquals(
      await listFeedsForSource(database, source.id, owner.id),
      [added],
    );
    assertEquals(runtime.calls, [{
      profileId: owner.id,
      url: "https://x.com/i/lists/123",
      signal: controller.signal,
    }]);

    await assertRejects(
      () =>
        service.add(
          stranger.id,
          source.id,
          "https://x.com/i/lists/123",
        ),
      NotFoundError,
      "source not found",
    );
    assertEquals(runtime.calls.length, 1);
  });
});

test("X target addition rejects noncanonical credentials and mismatched browser evidence", async () => {
  await withTestDb(async (database) => {
    const cipher = new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY));
    const owner = await fixtureUser(database, "x-target-invalid@example.com");
    const otherProfile = await fixtureUser(database, "x-target-profile@example.com");
    const mismatchedSource = await fixtureXSource(
      database,
      cipher,
      owner.id,
      otherProfile.id,
    );
    const runtime = new FakeXTargetRuntime();
    const service = new XTargetService({
      database,
      credentialCipher: cipher,
      browserRuntime: runtime,
    });

    await assertRejects(
      () =>
        service.add(
          owner.id,
          mismatchedSource.id,
          "https://x.com/home",
        ),
      ValidationError,
      "invalid X browser profile credentials",
    );
    assertEquals(runtime.calls, []);

    const validOwner = await fixtureUser(database, "x-target-valid@example.com");
    const validSource = await fixtureXSource(database, cipher, validOwner.id);
    runtime.result = {
      externalId: "x:list:124",
      name: "Wrong List",
      kind: "news",
    };
    await assertRejects(
      () =>
        service.add(
          validOwner.id,
          validSource.id,
          "https://x.com/i/lists/123",
        ),
      ValidationError,
      "X target did not resolve to the requested feed",
    );
  });
});

test("X target addition enforces the connector limit of active feeds per source", async () => {
  await withTestDb(async (database) => {
    const cipher = new CredentialCipher(new EnvMasterKeyProvider(MASTER_KEY));
    const owner = await fixtureUser(database, "x-target-cap@example.com");
    const source = await fixtureXSource(database, cipher, owner.id);
    const runtime = new FakeXTargetRuntime();
    const service = new XTargetService({
      database,
      credentialCipher: cipher,
      browserRuntime: runtime,
    });

    for (let index = 1; index <= MAX_X_FEEDS; index += 1) {
      runtime.result = {
        externalId: `x:list:${index}`,
        name: `List ${index}`,
        kind: "news",
      };
      await service.add(
        owner.id,
        source.id,
        `https://x.com/i/lists/${index}`,
      );
    }
    assertEquals(
      (await listFeedsForSource(database, source.id, owner.id)).length,
      MAX_X_FEEDS,
    );

    runtime.result = {
      externalId: `x:list:${MAX_X_FEEDS + 1}`,
      name: `List ${MAX_X_FEEDS + 1}`,
      kind: "news",
    };
    await assertRejects(
      () =>
        service.add(
          owner.id,
          source.id,
          `https://x.com/i/lists/${MAX_X_FEEDS + 1}`,
        ),
      ConflictError,
      `source has reached its limit of ${MAX_X_FEEDS} active feeds`,
    );
    assertEquals(
      (await listFeedsForSource(database, source.id, owner.id)).length,
      MAX_X_FEEDS,
    );
  });
});
