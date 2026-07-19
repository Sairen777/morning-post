import type { Database } from "../db/client.ts";
import {
  findFeedById,
  type PublicFeed,
} from "../repositories/feed-repository.ts";
import {
  listItemsForFeedInWindow,
  listMediaPathsForFeedWindow,
} from "../repositories/item-repository.ts";
import {
  assertFeedOwned,
  findSummaryForFeedPeriod,
  type PublicSummary,
  upsertSummaryForPeriod,
} from "../repositories/summary-repository.ts";
import { findUserById, type User } from "../repositories/user-repository.ts";
import { findSourceById } from "../repositories/source-repository.ts";
import { NotFoundError } from "../server/errors.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { composeSummaryRuleset } from "../summarizers/compose-prompt.ts";
import type {
  ArticleSummary,
  SummarizerService,
  SummaryContent,
} from "../summarizers/summarizer.types.ts";
import { getConfig } from "../config.ts";
import { ConnectorId, CONNECTORS_MEDIA_DIR } from "../constants.ts";

export interface SummarizeFeedPeriodDependencies {
  summarizer?: SummarizerService;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OwnedSummarizeFeedPeriodInput {
  user: User;
  feed: PublicFeed;
  connectorId: ConnectorId;
  periodStartMs: number;
  periodEndMs: number;
}

/**
 * Best-effort deletion of media files for a feed+time window after successful summarization.
 * Missing files and I/O errors log warnings but never throw.
 */
export async function cleanupFeedMedia(
  database: Database,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<void> {
  const paths = await listMediaPathsForFeedWindow(
    database,
    feedId,
    periodStartMs,
    periodEndMs,
  );
  for (const filePath of paths) {
    try {
      await Deno.remove(filePath);
    } catch (err: unknown) {
      if (err instanceof Deno.errors.NotFound) {
        // File already removed — not a concern
        continue;
      }
      console.warn(
        "[summarization] media file removal error (non-fatal):",
        sanitizeErrorForOps(err),
      );
    }
  }
}

/**
 * Best-effort deletion of expired media files older than TTL across all connector
 * media directories. Walks subdirectories recursively and includes orphaned paths
 * not linked to any DB row. Missing directories and per-file I/O errors log warnings
 * but never throw. Intended as a weekly housekeeping callback.
 */
export async function cleanupExpiredMedia(
  now: number,
  ttlMs: number,
): Promise<void> {
  const dirs = Object.values(CONNECTORS_MEDIA_DIR);
  for (const dir of dirs) {
    await cleanupExpiredMediaInDir(dir, now, ttlMs);
  }

  async function cleanupExpiredMediaInDir(
    dir: string,
    now: number,
    ttlMs: number,
  ): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await cleanupExpiredMediaInDir(fullPath, now, ttlMs);
        // After cleaning child dirs, try removing the directory itself if empty
        try {
          await Deno.remove(fullPath);
        } catch {
          // Directory not empty or permission denied — leave it
        }
        continue;
      }
      if (!entry.isFile) continue;

      try {
        const stat = await Deno.stat(fullPath);
        if (stat.mtime && (now - stat.mtime.getTime()) > ttlMs) {
          await Deno.remove(fullPath);
        }
      } catch (err: unknown) {
        console.warn(
          "[media-housekeeping] file removal error (non-fatal):",
          sanitizeErrorForOps(err),
        );
      }
    }
  }
}

function isInaccessiblePaidPost(
  payload: Parameters<SummarizerService["summarize"]>[0][number],
): boolean {
  return payload.meta?.audience === "only_paid" &&
    payload.meta?.contentAccess === "preview";
}

export async function summarizeOwnedFeedPeriod(
  database: Database,
  input: OwnedSummarizeFeedPeriodInput,
  dependencies: SummarizeFeedPeriodDependencies = {},
): Promise<PublicSummary> {
  dependencies.signal?.throwIfAborted();
  const summarizer = dependencies.summarizer ??
    new OpenAICompatibleSummarizerService();
  const nowFn = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? getConfig().summarizerTimeoutMs;

  // Build an abort controller: timeout + optional parent signal
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Summarizer timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  const onParentAbort = () => controller.abort(dependencies.signal?.reason);
  if (dependencies.signal) {
    if (dependencies.signal.aborted) {
      controller.abort(dependencies.signal.reason);
    } else {
      dependencies.signal.addEventListener("abort", onParentAbort, {
        once: true,
      });
    }
  }

  try {
    const items = await listItemsForFeedInWindow(
      database,
      input.feed.id,
      input.periodStartMs,
      input.periodEndMs,
    );
    let content: SummaryContent;
    if (input.connectorId === ConnectorId.Substack) {
      const rules = composeSummaryRuleset({
        connectorId: input.connectorId,
        kind: input.feed.kind,
        systemPrompt: input.user.systemPrompt,
        customPrompt: input.feed.customPrompt,
        language: input.user.defaultLanguage,
      });
      const articles: ArticleSummary[] = [];
      for (const item of items) {
        controller.signal.throwIfAborted();
        const payload = item.payload;
        const inaccessiblePaidPost = isInaccessiblePaidPost(payload);
        const hasText = payload.text.trim().length > 0;
        const points = inaccessiblePaidPost
          ? []
          : hasText
          ? await summarizer.summarize([payload], rules, {
            signal: controller.signal,
            summaryMode: "article",
          })
          : [];
        controller.signal.throwIfAborted();
        if (!inaccessiblePaidPost && hasText && points.length === 0) {
          throw new Error(
            `Summarizer returned no points for nonempty article ${payload.externalId}`,
          );
        }
        articles.push({
          sourceExternalId: payload.externalId,
          title: payload.title?.trim() || "Untitled article",
          sourceUrl: payload.url,
          publishedAt: payload.date,
          contentAccess: inaccessiblePaidPost
            ? "paid"
            : payload.meta?.contentAccess === "preview"
            ? "preview"
            : "full",
          points,
        });
      }
      content = { kind: "articles", articles };
      controller.signal.throwIfAborted();
    } else {
      const points = items.length === 0 ? [] : await summarizer.summarize(
        items.map((item) => item.payload),
        composeSummaryRuleset({
          connectorId: input.connectorId,
          kind: input.feed.kind,
          systemPrompt: input.user.systemPrompt,
          customPrompt: input.feed.customPrompt,
          language: input.user.defaultLanguage,
        }),
        { signal: controller.signal },
      );
      controller.signal.throwIfAborted();
      content = { kind: "aggregate", points };
    }

    controller.signal.throwIfAborted();

    const result = await upsertSummaryForPeriod(
      database,
      {
        feedId: input.feed.id,
        periodStartMs: input.periodStartMs,
        periodEndMs: input.periodEndMs,
        content,
        feedNameSnapshot: input.feed.name,
      },
      nowFn(),
    );

    // Best-effort media cleanup after successful summarization
    await cleanupFeedMedia(
      database,
      input.feed.id,
      input.periodStartMs,
      input.periodEndMs,
    ).catch(
      (err: unknown) => {
        console.warn(
          "[summarization] media cleanup error (non-fatal):",
          sanitizeErrorForOps(err),
        );
      },
    );

    return result;
  } finally {
    clearTimeout(timer);
    if (dependencies.signal) {
      dependencies.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export async function summarizeFeedPeriod(
  database: Database,
  userId: string,
  feedId: string,
  periodStartMs: number,
  periodEndMs: number,
  dependencies: SummarizeFeedPeriodDependencies = {},
): Promise<PublicSummary> {
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
  const source = await findSourceById(database, feed.sourceId, userId);
  if (!source) {
    throw new NotFoundError("source not found");
  }

  return await summarizeOwnedFeedPeriod(
    database,
    {
      user,
      feed,
      connectorId: source.connectorId as ConnectorId,
      periodStartMs,
      periodEndMs,
    },
    dependencies,
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
  const existingSummary = await findSummaryForFeedPeriod(
    database,
    feedId,
    periodStartMs,
    periodEndMs,
  );
  if (existingSummary) {
    return existingSummary;
  }
  return await summarizeFeedPeriod(
    database,
    userId,
    feedId,
    periodStartMs,
    periodEndMs,
    dependencies,
  );
}
