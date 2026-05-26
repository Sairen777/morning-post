import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";
import { OpenAICompatibleSummarizerService } from "./summarizers/openai-compatible-summarizer.ts";
import type {
  NormalizedItem,
  SummaryPoint,
} from "./summarizers/summarizer.types.ts";
import type { IConnectorNormalizedEntityData } from "./connectors/connector.types.ts";

const app = new Hono();
app.get("/", (c) => c.text("Hello Hono"));

Deno.serve({ port: 3000 }, app.fetch);
console.log("Hono is running at http://localhost:3000");

function toNormalizedItems(
  entityName: string,
  messages: IConnectorNormalizedEntityData[],
): NormalizedItem[] {
  return messages.map((msg) => ({
    connectorId: "telegram",
    sourceId: entityName,
    date: new Date(msg.timestamp),
    title: null,
    text: msg.text,
    author: msg.author,
    url: msg.url ?? null,
    media: msg.media,
    isGroup: msg.isGroup ?? false,
  }));
}

function printSummary(entityName: string, summary: SummaryPoint[]): void {
  console.log(`\n=== ${entityName} ===\n`);
  for (const point of summary) {
    console.log(`• ${point.text}`);
    if (point.channel || point.sourceUrl) {
      const meta = [point.channel, point.date, point.sourceUrl]
        .filter(Boolean)
        .join(" · ");
      console.log(`  ${meta}`);
    }
  }
}

try {
  const from = new Date();
  from.setDate(from.getDate() - 7);
  const to = new Date();
  to.setDate(to.getDate() - 5);
  const tgClient = await createTelegramClient();
  const telegramConnector = new TelegramConnector(tgClient);
  const normalized = await telegramConnector.getNormalizedData(from, to);

  const entities = Object.entries(normalized);
  const totalMessages = entities.reduce(
    (sum, [, msgs]) => sum + msgs.length,
    0,
  );
  console.log(
    `Fetched ${totalMessages} messages across ${entities.length} entities. Summarizing...`,
  );

  const summarizer = new OpenAICompatibleSummarizerService();

  // One LLM request per entity — keeps context focused and avoids topic bleed between channels.
  // Promise.all parallelizes for hosted APIs; a local LLM will serialize requests on its end.
  const results = await Promise.all(
    entities.map(async ([entityName, messages]) => {
      const items = toNormalizedItems(entityName, messages);
      const isGroup = messages[0]?.isGroup ?? false;
      const t0 = performance.now();
      const summary = await summarizer.summarize(items, {
        mode: isGroup ? "discussion" : undefined,
        format: isGroup ? undefined : "bullet points",
      });
      console.log(
        `${entityName}: ${((performance.now() - t0) / 1000).toFixed(1)}s (${summary.length} points)`,
      );
      return { entityName, isGroup, summary };
    }),
  );

  await Deno.mkdir(".debug_logs", { recursive: true });
  await Deno.writeTextFile(
    ".debug_logs/normalized.json",
    JSON.stringify(normalized, null, 2),
  );
  await Deno.writeTextFile(
    ".debug_logs/summary.json",
    JSON.stringify(results, null, 2),
  );

  for (const { entityName, summary } of results) {
    printSummary(entityName, summary);
  }

  // await Deno.remove("media", { recursive: true });
} catch (error) {
  console.error(error);
}
