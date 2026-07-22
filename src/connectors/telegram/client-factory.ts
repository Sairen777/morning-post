import type { TelegramClient } from "telegram";
import type { StringSession } from "telegram/sessions/index.js";
import { sanitizeErrorForOps } from "../../server/error-sanitizer.ts";

export interface TelegramApiCredentials {
  apiId: number;
  apiHash: string;
}

export function readTelegramApiCredentials(): TelegramApiCredentials {
  return {
    apiId: Number(process.env["TELEGRAM_API_ID"]),
    apiHash: process.env["TELEGRAM_API_HASH"] ?? "",
  };
}

export interface DestroyableTelegramClient {
  destroy(): Promise<void> | void;
}

export async function destroyTelegramClient(
  client: DestroyableTelegramClient,
): Promise<void> {
  await client.destroy();
}

export interface TelegramClientConstructionOptions {
  connectionRetries: number;
  deviceModel: string;
  systemVersion: string;
}

const TELEGRAM_CLIENT_OPTIONS: TelegramClientConstructionOptions = {
  connectionRetries: 5,
  deviceModel: "Morning Post",
  systemVersion: "Bun",
};

export interface TelegramClientFactoryDependencies {
  constructClient?: (
    sessionString: string,
    credentials: TelegramApiCredentials,
    options: TelegramClientConstructionOptions,
  ) => Promise<TelegramClient>;
}

async function constructTelegramClient(
  sessionString: string,
  credentials: TelegramApiCredentials,
  options: TelegramClientConstructionOptions,
): Promise<TelegramClient> {
  let TelegramClientConstructor: typeof TelegramClient;
  let StringSessionConstructor: typeof StringSession;
  try {
    // Deliberately lazy: GramJS and its websocket/debug dependencies are only needed for Telegram use.
    const telegram = await import("telegram");
    const sessions = await import("telegram/sessions/index.js");
    TelegramClientConstructor = telegram.TelegramClient;
    StringSessionConstructor = sessions.StringSession;
  } catch (error) {
    throw new Error("Failed to load Telegram client runtime", { cause: error });
  }
  return new TelegramClientConstructor(
    new StringSessionConstructor(sessionString),
    credentials.apiId,
    credentials.apiHash,
    options,
  );
}

async function createTelegramClientWithSession(
  sessionString: string,
  dependencies: TelegramClientFactoryDependencies = {},
): Promise<TelegramClient> {
  const credentials = readTelegramApiCredentials();
  const client =
    await (dependencies.constructClient ?? constructTelegramClient)(
      sessionString,
      credentials,
      TELEGRAM_CLIENT_OPTIONS,
    );

  try {
    await client.connect();
    return client;
  } catch (error) {
    try {
      await destroyTelegramClient(client);
    } catch (cleanupError) {
      console.error(
        "Failed to destroy Telegram client after connection failure:",
        sanitizeErrorForOps(cleanupError),
      );
      // Preserve the acquisition failure; it is the actionable error.
    }
    throw error;
  }
}

export async function createClientFromSession(
  sessionString: string,
  dependencies: TelegramClientFactoryDependencies = {},
): Promise<TelegramClient> {
  return await createTelegramClientWithSession(sessionString, dependencies);
}

export async function createUnauthenticatedTelegramClient(
  dependencies: TelegramClientFactoryDependencies = {},
): Promise<TelegramClient> {
  return await createTelegramClientWithSession("", dependencies);
}
