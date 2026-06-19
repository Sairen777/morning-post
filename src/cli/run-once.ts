import { createTelegramClient } from "../connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "../connectors/telegram/telegram-connector.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { Pipeline } from "../pipeline/pipeline.ts";
import type { SummaryPoint } from "../summarizers/summarizer.types.ts";

function printSummary(feedExternalId: string, summary: SummaryPoint[]): void {
  console.log(`\n=== ${feedExternalId} ===\n`);
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
  for (const { feedExternalId, summary } of results) {
    printSummary(feedExternalId, summary);
  }
} catch (error) {
  console.error(error);
}
