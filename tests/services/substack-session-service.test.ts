import { test } from "bun:test";
import { assertEquals, assertRejects } from "../assertions.ts"
import { ConnectorId } from "../../src/constants.ts";
import { CredentialCipher } from "../../src/crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../../src/crypto/key-provider.ts";
import {
  SubstackSessionUpstreamError,
} from "../../src/connectors/substack/session-client.ts";
import { withTestDb } from "../../src/db/testing.ts";
import {
  findSourceByConnectorId,
  getDecryptedCredentials,
} from "../../src/repositories/source-repository.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import {
  SubstackSessionService,
  type SubstackSessionValidatorFactory,
} from "../../src/services/substack-session-service.ts";
import { ValidationError } from "../../src/server/errors.ts";

const credentials = {
  substackSessionId: "s%3Asubstack.signature",
  connectSessionId: "s%3Aconnect.signature",
};

function cipher(): CredentialCipher {
  return new CredentialCipher(
    new EnvMasterKeyProvider(new Uint8Array(32).fill(23)),
  );
}

function userInput(email: string) {
  return {
    name: "Substack Reader",
    email,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
    defaultLanguage: "en",
  };
}

test("SubstackSessionService validates before encrypted source upsert", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-session@example.com"),
    );
    let validated = false;
    const validatorFactory: SubstackSessionValidatorFactory = {
      create: () => ({
        validateSession: () => {
          validated = true;
          return Promise.resolve({ userId: 42 });
        },
      }),
    };
    const service = new SubstackSessionService(
      database,
      validatorFactory,
      cipher(),
    );
    const source = await service.connect(user.id, credentials);
    assertEquals(validated, true);
    assertEquals(source.connectorId, ConnectorId.Substack);
    assertEquals(source.connected, true);
    assertEquals(
      await getDecryptedCredentials(database, source.id, user.id, cipher()),
      credentials,
    );
  });
});

test("SubstackSessionService leaves state unchanged when validation fails", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-invalid-session@example.com"),
    );
    const validatorFactory: SubstackSessionValidatorFactory = {
      create: () => ({
        validateSession: () =>
          Promise.reject(new Error("private upstream details")),
      }),
    };
    const service = new SubstackSessionService(
      database,
      validatorFactory,
      cipher(),
    );
    await assertRejects(
      () => service.connect(user.id, credentials),
      ValidationError,
      "Substack session is invalid or expired",
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.Substack),
      null,
    );
  });
});

test("SubstackSessionService does not misclassify provider failures as expired", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-provider-failure@example.com"),
    );
    const validatorFactory: SubstackSessionValidatorFactory = {
      create: () => ({
        validateSession: () =>
          Promise.reject(
            new SubstackSessionUpstreamError(
              "Substack request failed with status 403",
            ),
          ),
      }),
    };
    const service = new SubstackSessionService(
      database,
      validatorFactory,
      cipher(),
    );
    await assertRejects(
      () => service.connect(user.id, credentials),
      Error,
      "Substack request failed with status 403",
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.Substack),
      null,
    );
  });
});

test("SubstackSessionService reconnect replaces credentials without duplicating source", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-reconnect@example.com"),
    );
    const validatorFactory: SubstackSessionValidatorFactory = {
      create: () => ({
        validateSession: () => Promise.resolve({ userId: 42 }),
      }),
    };
    const service = new SubstackSessionService(
      database,
      validatorFactory,
      cipher(),
    );
    const first = await service.connect(user.id, credentials);
    const replacement = {
      substackSessionId: "s%3Areplacement.signature",
      connectSessionId: "s%3Areplacement-connect.signature",
    };
    const second = await service.connect(user.id, replacement);
    assertEquals(second.id, first.id);
    assertEquals(
      await getDecryptedCredentials(database, first.id, user.id, cipher()),
      replacement,
    );
  });
});

test("SubstackSessionService does not persist after its signal is aborted", async () => {
  await withTestDb(async (database) => {
    const user = await createUser(
      database,
      userInput("substack-aborted-session@example.com"),
    );
    const controller = new AbortController();
    const validatorFactory: SubstackSessionValidatorFactory = {
      create: () => ({
        validateSession: () => {
          controller.abort();
          return Promise.resolve({ userId: 42 });
        },
      }),
    };
    const service = new SubstackSessionService(
      database,
      validatorFactory,
      cipher(),
    );
    await assertRejects(
      () => service.connect(user.id, credentials, controller.signal),
      ValidationError,
      "Substack session is invalid or expired",
    );
    assertEquals(
      await findSourceByConnectorId(database, user.id, ConnectorId.Substack),
      null,
    );
  });
});
