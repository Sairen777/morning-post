import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { createSource } from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  type SubstackPublicationDiscoveryClientFactory,
  SubstackPublicationDiscoveryService,
} from "../../src/services/substack-publication-discovery-service.ts";
import {
  SubstackSessionExpiredError,
  SubstackSessionUpstreamError,
} from "../../src/connectors/substack/session-client.ts";
import { ConflictError, ValidationError } from "../../src/server/errors.ts";

const credentialCipher = new CredentialCipher(
  new EnvMasterKeyProvider(new Uint8Array(32).fill(73)),
);

function userInput(email: string) {
  return {
    name: "Discovery Reader",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

Deno.test("SubstackPublicationDiscoveryService decrypts, validates, and canonicalizes subscribed publications", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-discovery@example.com"),
    );
    const credentials = { substackSessionId: "s%3Asubstack.signature" };
    const encrypted = await credentialCipher.encrypt(
      JSON.stringify(credentials),
      {
        userId: user.id,
        connectorId: ConnectorId.Substack,
      },
    );
    await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Substack,
      credentials: encrypted,
    });
    const calls: unknown[] = [];
    const factory: SubstackPublicationDiscoveryClientFactory = {
      create: (receivedCredentials) => {
        calls.push(receivedCredentials);
        return {
          validateSession: () => Promise.resolve({ userId: 42 }),
          listSubscribedPublications: () => {
            calls.push("listed");
            return Promise.resolve([
              {
                id: 1,
                name: " Custom Letter ",
                customDomain: "letter.example.com",
                subdomain: "old",
              },
              {
                id: 2,
                name: " ",
                customDomain: "http://invalid.example.com",
                subdomain: "fallback",
              },
              {
                id: 2,
                name: "Duplicate",
                customDomain: null,
                subdomain: "duplicate",
              },
              { id: 3, name: null, customDomain: null, subdomain: "bad/path" },
            ]);
          },
        };
      },
    };
    const service = new SubstackPublicationDiscoveryService(
      database,
      factory,
      credentialCipher,
    );

    assertEquals(await service.list(user.id), [
      {
        externalId: "https://letter.example.com",
        name: "Custom Letter",
        kind: "news",
      },
      {
        externalId: "https://fallback.substack.com",
        name: "fallback.substack.com",
        kind: "news",
      },
    ]);
    assertEquals(calls, [credentials, "listed"]);
  });
});

Deno.test("SubstackPublicationDiscoveryService preserves connection and provider error distinctions", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-discovery-errors@example.com"),
    );
    const disconnectedFactory: SubstackPublicationDiscoveryClientFactory = {
      create: () => {
        throw new Error("must not create client");
      },
    };
    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          disconnectedFactory,
          credentialCipher,
        ).list(user.id),
      ConflictError,
      "Connect your Substack session first",
    );

    const encrypted = await credentialCipher.encrypt(
      JSON.stringify({
        substackSessionId: "s%3Asubstack.signature",
      }),
      { userId: user.id, connectorId: ConnectorId.Substack },
    );
    await createSource(database, {
      userId: user.id,
      connectorId: ConnectorId.Substack,
      credentials: encrypted,
    });
    const expiredFactory: SubstackPublicationDiscoveryClientFactory = {
      create: () => ({
        validateSession: () =>
          Promise.reject(new SubstackSessionExpiredError()),
        listSubscribedPublications: () => Promise.resolve([]),
      }),
    };
    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          expiredFactory,
          credentialCipher,
        ).list(user.id),
      ValidationError,
      "Substack session is invalid or expired",
    );

    const expiredDuringListingFactory:
      SubstackPublicationDiscoveryClientFactory = {
        create: () => ({
          validateSession: () => Promise.resolve({ userId: 42 }),
          listSubscribedPublications: () =>
            Promise.reject(new SubstackSessionExpiredError()),
        }),
      };
    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          expiredDuringListingFactory,
          credentialCipher,
        ).list(user.id),
      ValidationError,
      "Substack session is invalid or expired",
    );

    const upstreamFactory: SubstackPublicationDiscoveryClientFactory = {
      create: () => ({
        validateSession: () =>
          Promise.reject(
            new SubstackSessionUpstreamError("provider unavailable"),
          ),
        listSubscribedPublications: () => Promise.resolve([]),
      }),
    };
    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          upstreamFactory,
          credentialCipher,
        ).list(user.id),
      SubstackSessionUpstreamError,
      "provider unavailable",
    );
  });
});

Deno.test("SubstackPublicationDiscoveryService scopes ownership and rejects undecryptable credentials", async () => {
  await withTestDb(async (database) => {
    const owner = await createUser(
      database,
      userInput("substack-discovery-owner@example.com"),
    );
    const otherUser = await createUser(
      database,
      userInput("substack-discovery-other@example.com"),
    );
    const encrypted = await credentialCipher.encrypt(
      JSON.stringify({
        substackSessionId: "s%3Asubstack.signature",
      }),
      { userId: owner.id, connectorId: ConnectorId.Substack },
    );
    await createSource(database, {
      userId: owner.id,
      connectorId: ConnectorId.Substack,
      credentials: encrypted,
    });
    const unusedFactory: SubstackPublicationDiscoveryClientFactory = {
      create: () => {
        throw new Error("must not create client");
      },
    };

    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          unusedFactory,
          credentialCipher,
        ).list(otherUser.id),
      ConflictError,
      "Connect your Substack session first",
    );

    const wrongCredentialCipher = new CredentialCipher(
      new EnvMasterKeyProvider(new Uint8Array(32).fill(74)),
    );
    await assertRejects(
      () =>
        new SubstackPublicationDiscoveryService(
          database,
          unusedFactory,
          wrongCredentialCipher,
        ).list(owner.id),
      ValidationError,
      "source credentials could not be decrypted",
    );
  });
});
