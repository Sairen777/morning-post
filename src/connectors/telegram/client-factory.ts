import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

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
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
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
