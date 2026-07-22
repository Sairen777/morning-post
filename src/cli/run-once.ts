import type { TelegramClient } from "telegram";
import {
  getSummarizerRuntimeConfig,
  resolveAllowRemoteSummarization,
} from "../config.ts";
import {
  type DestroyableTelegramClient,
  destroyTelegramClient,
} from "../connectors/telegram/client-factory.ts";
import { createTelegramClient } from "../connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "../connectors/telegram/telegram-connector.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { type FeedSummary, Pipeline } from "../pipeline/pipeline.ts";
import type { SummaryPoint } from "../summarizers/summarizer.types.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";
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

interface OneShotPipeline {
  run(from: number, to: number): Promise<FeedSummary[]>;
}

export interface RunOnceDependencies {
  now(): number;
  createClient(): Promise<DestroyableTelegramClient>;
  createPipeline(client: DestroyableTelegramClient): OneShotPipeline;
}

const defaultDependencies: RunOnceDependencies = {
  now: Date.now,
  createClient: createTelegramClient,
  createPipeline: (client) => {
    const models = getSummarizerRuntimeConfig();
    const allowRemoteSummarization = resolveAllowRemoteSummarization();
    const summarizer = new OpenAICompatibleSummarizerService({
      models,
      allowRemoteSummarization,
    });
    return new Pipeline(
      new TelegramConnector(client as TelegramClient),
      summarizer,
    );
  },
};

export async function runOnce(
  dependencies: RunOnceDependencies = defaultDependencies,
): Promise<void> {
  const now = dependencies.now();
  const from = now - 7 * 24 * 60 * 60 * 1000;
  const to = now - 5 * 24 * 60 * 60 * 1000;
  const client = await dependencies.createClient();
  try {
    const pipeline = dependencies.createPipeline(client);
    const results = await pipeline.run(from, to);
    for (const { feedExternalId, summary } of results) {
      printSummary(feedExternalId, summary);
    }
  } finally {
    await destroyTelegramClient(client);
  }
}

if (import.meta.main) {
  try {
    await runOnce();
  } catch (error) {
    console.error(sanitizeErrorForOps(error));
    process.exitCode = 1;
  }
}
