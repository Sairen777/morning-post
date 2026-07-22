import { test } from "bun:test";
import { assertEquals, assertRejects, assertStrictEquals } from "./assertions.ts";
import type { TelegramClient } from "telegram";
import {
  createClientFromSession,
  type TelegramClientConstructionOptions,
} from "../src/connectors/telegram/client-factory.ts";
import { createTelegramClient } from "../src/connectors/telegram/telegram-client.ts";

function asTelegramClient(client: object): TelegramClient {
  return client as TelegramClient;
}

test("client factory supplies stable runtime identity without loading GramJS", async () => {
  let capturedOptions: TelegramClientConstructionOptions | undefined;
  const client = asTelegramClient({
    connect: () => Promise.resolve(),
  });

  await createClientFromSession("session", {
    constructClient: (_session, _credentials, options) => {
      capturedOptions = options;
      return Promise.resolve(client);
    },
  });

  assertEquals(capturedOptions?.connectionRetries, 5);
  assertEquals(capturedOptions?.deviceModel, "Morning Post");
  assertEquals(capturedOptions?.systemVersion, "Bun");
});

test("client factory destroys a constructed client exactly once when connect fails", async () => {
  const connectFailure = new Error("connect failed");
  let destroyCount = 0;
  const client = asTelegramClient({
    connect: () => Promise.reject(connectFailure),
    destroy: () => {
      destroyCount += 1;
      return Promise.resolve();
    },
  });

  const rejection = await assertRejects(() =>
    createClientFromSession("session", {
      constructClient: () => Promise.resolve(client),
    })
  );

  assertStrictEquals(rejection, connectFailure);
  assertEquals(destroyCount, 1);
});

test("client factory preserves connect failure when destroy also fails", async () => {
  const connectFailure = new Error("connect failed");
  let destroyCount = 0;
  const client = asTelegramClient({
    connect: () => Promise.reject(connectFailure),
    destroy: () => {
      destroyCount += 1;
      return Promise.reject(new Error("destroy failed"));
    },
  });

  const rejection = await assertRejects(() =>
    createClientFromSession("session", {
      constructClient: () => Promise.resolve(client),
    })
  );

  assertStrictEquals(rejection, connectFailure);
  assertEquals(destroyCount, 1);
});

test("CLI client destroys an acquired client when authorization check fails", async () => {
  const authorizationFailure = new Error("authorization check failed");
  let destroyCount = 0;
  const client = asTelegramClient({
    isUserAuthorized: () => Promise.reject(authorizationFailure),
    destroy: () => {
      destroyCount += 1;
      return Promise.resolve();
    },
  });

  const rejection = await assertRejects(() =>
    createTelegramClient({
      acquireClient: () => Promise.resolve(client),
      readCredentials: () => ({ apiId: 1, apiHash: "hash" }),
    })
  );

  assertStrictEquals(rejection, authorizationFailure);
  assertEquals(destroyCount, 1);
});

test("CLI client destroys an acquired client and preserves QR authorization failure", async () => {
  const qrFailure = new Error("QR authorization failed");
  let destroyCount = 0;
  const client = asTelegramClient({
    isUserAuthorized: () => Promise.resolve(false),
    signInUserWithQrCode: () => Promise.reject(qrFailure),
    destroy: () => {
      destroyCount += 1;
      return Promise.reject(new Error("destroy failed"));
    },
  });

  const rejection = await assertRejects(() =>
    createTelegramClient({
      acquireClient: () => Promise.resolve(client),
      readCredentials: () => ({ apiId: 1, apiHash: "hash" }),
    })
  );

  assertStrictEquals(rejection, qrFailure);
  assertEquals(destroyCount, 1);
});
