import type { Database } from "../db/client.ts";
import { findFeedById } from "../repositories/feed-repository.ts";
import { listItemsForFeedInWindow } from "../repositories/item-repository.ts";
import {
  assertFeedOwned,
  findSummaryForFeedPeriod,
  upsertSummaryForPeriod,
  type PublicSummary,
} from "../repositories/summary-repository.ts";
import { findUserById } from "../repositories/user-repository.ts";
import { NotFoundError } from "../server/errors.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { composeSummaryRuleset } from "../summarizers/compose-prompt.ts";
import type { SummarizerService } from "../summarizers/summarizer.types.ts";

export interface SummarizeFeedPeriodDependencies {
  summarizer?: SummarizerService;
  now?: () => number;
}

export async function summarizeFeedPeriod(
  database: Database,
  userId: string,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
  dependencies: SummarizeFeedPeriodDependencies = {},
): Promise<PublicSummary> {
  const summarizer = dependencies.summarizer ?? new OpenAICompatibleSummarizerService();
  const now = dependencies.now ?? Date.now;

  const [feed, user] = await Promise.all([
    findFeedById(database, feedId, userId),
    findUserById(database, userId),
  ]);
  if (!feed) {
    throw new NotFoundError("feed not found");
  }
  if (!user) {
    throw new NotFoundError("user not found");
  }

  const items = await listItemsForFeedInWindow(database, feedId, periodStartMs, periodEndMs);
  const points = items.length === 0
    ? []
    : await summarizer.summarize(
      items.map((item) => item.payload),
      composeSummaryRuleset({
        kind: feed.kind,
        systemPrompt: user.systemPrompt,
        customPrompt: feed.customPrompt,
        language: user.defaultLanguage,
      }),
      { model: user.defaultModel ?? undefined },
    );

  return await upsertSummaryForPeriod(
    database,
    {
      feedId,
      periodStartMs,
      periodEndMs,
      points,
      feedNameSnapshot: feed.name,
    },
    now(),
  );
}

export async function getOrSummarizeFeedPeriod(
  database: Database,
  userId: string,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
  dependencies: SummarizeFeedPeriodDependencies = {},
): Promise<PublicSummary> {
  await assertFeedOwned(database, feedId, userId);
  const existingSummary = await findSummaryForFeedPeriod(database, feedId, periodStartMs, periodEndMs);
  if (existingSummary) {
    return existingSummary;
  }
  return await summarizeFeedPeriod(database, userId, feedId, periodStartMs, periodEndMs, dependencies);
}
