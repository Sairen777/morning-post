import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";
import { OpenAICompatibleSummarizerService } from "./summarizers/openai-compatible-summarizer.ts";
import { Pipeline } from "./pipeline/pipeline.ts";
import type { SummaryPoint } from "./summarizers/summarizer.types.ts";

const app = new Hono();
app.get("/", (c) => c.text("Hello Hono"));

Deno.serve({ port: 3000 }, app.fetch);
console.log("Hono is running at http://localhost:3000");

function printSummary(sourceId: string, summary: SummaryPoint[]): void {
  console.log(`\n=== ${sourceId} ===\n`);
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
  const pipeline = new Pipeline(
    new TelegramConnector(tgClient),
    new OpenAICompatibleSummarizerService(),
  );

  const results = await pipeline.run(from, to);
  for (const { sourceId, summary } of results) {
    printSummary(sourceId, summary);
  }
} catch (error) {
  console.error(error);
}
