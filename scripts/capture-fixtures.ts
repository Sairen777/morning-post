/**
 * Connects to real Telegram and saves connector output as test fixtures.
 * Run via: bun run capture-fixtures
 *
 * Writes:
 *   tests/fixtures/normalized-data.json  — output of getNormalizedData()
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createTelegramClient } from "../src/connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "../src/connectors/telegram/telegram-connector.ts";

const from = new Date();
from.setDate(from.getDate() - 2);
const to = new Date();

console.log(
  `Fetching Telegram data from ${from.toISOString()} to ${to.toISOString()}...`,
);

const client = await createTelegramClient();
const connector = new TelegramConnector(client);

const normalized = await connector.getNormalizedData(from.getTime(), to.getTime());

await mkdir("tests/fixtures", { recursive: true });
await writeFile(
  "tests/fixtures/normalized-data.json",
  JSON.stringify(normalized, null, 2),
  "utf8",
);

const entityCount = Object.keys(normalized).length;
const msgCount = Object.values(normalized).reduce(
  (s, msgs) => s + msgs.length,
  0,
);
console.log(
  `Saved ${msgCount} messages from ${entityCount} entities to tests/fixtures/normalized-data.json`,
);

await client.disconnect();
