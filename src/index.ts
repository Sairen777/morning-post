import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";
import { OpenAICompatibleSummarizerService } from "./summarizers/openai-compatible-summarizer.ts";
import {
  buildDiscussionPrompt,
  buildNewsPrompt,
} from "./summarizers/prompts.ts";
import type { SummaryPoint } from "./summarizers/summarizer.types.ts";

const app = new Hono();
app.get("/", (c) => c.text("Hello Hono"));

Deno.serve({ port: 3000 }, app.fetch);
console.log("Hono is running at http://localhost:3000");

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
  const now = Date.now();
  const from = now - 7 * 24 * 60 * 60 * 1000;
  const to = now - 5 * 24 * 60 * 60 * 1000;
  const tgClient = await createTelegramClient();
  const telegramConnector = new TelegramConnector(tgClient);
  const normalized = await telegramConnector.getNormalizedData(from, to);

  const entities = Object.entries(normalized);
  const totalMessages = entities.reduce(
    (sum, [, items]) => sum + items.length,
    0,
  );
  console.log(
    `Fetched ${totalMessages} messages across ${entities.length} entities. Summarizing...`,
  );

  const summarizer = new OpenAICompatibleSummarizerService();

  // One LLM request per entity — keeps context focused and avoids topic bleed between channels.
  // Promise.all parallelizes for hosted APIs; a local LLM will serialize requests on its end.
  const results = await Promise.all(
    entities.map(async ([entityName, items]) => {
      const isGroup = items[0]?.meta?.isGroup === true;
      const rules = isGroup ? buildDiscussionPrompt() : buildNewsPrompt();
      const t0 = performance.now();
      const summary = await summarizer.summarize(items, rules);
      console.log(
        `${entityName}: ${
          ((performance.now() - t0) / 1000).toFixed(1)
        }s (${summary.length} points)`,
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
