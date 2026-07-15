import type { TelegramClient } from "telegram";
import type { StringSession } from "telegram/sessions/index.js";

export interface TelegramApiCredentials {
  apiId: number;
  apiHash: string;
}

export function readTelegramApiCredentials(): TelegramApiCredentials {
  return {
    apiId: Number(Deno.env.get("TELEGRAM_API_ID")),
    apiHash: Deno.env.get("TELEGRAM_API_HASH") ?? "",
  };
}

async function createTelegramClientWithSession(sessionString: string): Promise<TelegramClient> {
  const { apiId, apiHash } = readTelegramApiCredentials();
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
  const client = new TelegramClientConstructor(new StringSessionConstructor(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  return client;
}

export async function createClientFromSession(sessionString: string): Promise<TelegramClient> {
  return await createTelegramClientWithSession(sessionString);
}

export async function createUnauthenticatedTelegramClient(): Promise<TelegramClient> {
  return await createTelegramClientWithSession("");
}
