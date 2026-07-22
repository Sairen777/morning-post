import { readdir, rm, stat, unlink } from "node:fs/promises";
import { isFileNotFoundError } from "../platform/filesystem-errors.ts";
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
import {
  appendOperationalLog,
  type OperationalLogEvent,
  type OperationalLogRecorder,
} from "../observability/operational-log.ts";
import { OpenAICompatibleSummarizerService } from "../summarizers/openai-compatible-summarizer.ts";
import { composeSummaryRuleset } from "../summarizers/compose-prompt.ts";
import type {
  ArticleSummary,
  SummarizationDiagnostic,
  SummarizeOptions,
  SummarizerService,
  SummaryContent,
  SummaryPoint,
  SummaryRuleset,
} from "../summarizers/summarizer.types.ts";
import { getConfig } from "../config.ts";
import { ConnectorId, CONNECTORS_MEDIA_DIR } from "../constants.ts";

export interface SummarizeFeedPeriodDependencies {
  summarizer?: SummarizerService;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  runId?: string;
  recordOperationalEvent?: OperationalLogRecorder;
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
      await unlink(filePath);
    } catch (err: unknown) {
      if (isFileNotFoundError(err)) {
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
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await cleanupExpiredMediaInDir(fullPath, now, ttlMs);
        // After cleaning child dirs, try removing the directory itself if empty
        try {
          await rm(fullPath);
        } catch {
          // Directory not empty or permission denied — leave it
        }
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const fileStat = await stat(fullPath);
        if ((now - fileStat.mtimeMs) > ttlMs) {
          await unlink(fullPath);
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

const MAXIMUM_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3;
const MAXIMUM_LOGICAL_SOURCE_CALLS_PER_CHUNK = 2;
const MAXIMUM_PAIRWISE_MERGE_CALLS_PER_INPUT = 2;
const PAIRWISE_MERGE_ROOT_CALL_ADJUSTMENT = 1;
const MAXIMUM_HTTP_ATTEMPTS_PER_LOGICAL_CALL = 3;
const MAXIMUM_SUMMARIZATION_OPERATION_TIMEOUT_MS = 3 * 60 * 60 * 1_000;

interface SummarizationDeadlineOptions {
  requestTimeoutMs: number;
  maxTextBytesPerChunk: number;
}

function calculateSummarizationOperationTimeout(
  items: Parameters<SummarizerService["summarize"]>[0],
  options: SummarizationDeadlineOptions,
): number {
  const maximumChunkCount = items.reduce(
    (count, item) =>
      count +
      Math.max(
        1,
        Math.ceil(
          (item.text.length * MAXIMUM_UTF8_BYTES_PER_UTF16_CODE_UNIT) /
            options.maxTextBytesPerChunk,
        ),
      ),
    0,
  );
  const boundedChunkCount = Math.max(1, maximumChunkCount);
  const maximumSourceCallCount =
    boundedChunkCount * MAXIMUM_LOGICAL_SOURCE_CALLS_PER_CHUNK;
  const maximumHierarchicalMergeCallCount =
    maximumSourceCallCount * MAXIMUM_PAIRWISE_MERGE_CALLS_PER_INPUT -
    PAIRWISE_MERGE_ROOT_CALL_ADJUSTMENT;
  const maximumLogicalCallCount =
    maximumSourceCallCount + maximumHierarchicalMergeCallCount;
  const maximumRequestTimeoutCount =
    maximumLogicalCallCount * MAXIMUM_HTTP_ATTEMPTS_PER_LOGICAL_CALL;
  return Math.min(
    options.requestTimeoutMs * maximumRequestTimeoutCount,
    MAXIMUM_SUMMARIZATION_OPERATION_TIMEOUT_MS,
  );
}

async function summarizeWithDeadline(
  summarizer: SummarizerService,
  items: Parameters<SummarizerService["summarize"]>[0],
  rules: SummaryRuleset,
  options: SummarizeOptions,
  deadlineOptions: SummarizationDeadlineOptions,
): Promise<SummaryPoint[]> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let rejectOperation!: (reason: unknown) => void;
  const operationDeadline = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const abortOperation = (reason: unknown) => {
    controller.abort(reason);
    rejectOperation(reason);
  };
  const onParentAbort = () =>
    abortOperation(
      options.signal?.reason ?? new DOMException("Aborted", "AbortError"),
    );
  options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(
    () =>
      abortOperation(
        new DOMException("Summarizer timed out", "TimeoutError"),
      ),
    calculateSummarizationOperationTimeout(items, deadlineOptions),
  );

  try {
    const summarization = summarizer.summarize(items, rules, {
      ...options,
      signal: controller.signal,
      requestTimeoutMs: deadlineOptions.requestTimeoutMs,
    });
    return await Promise.race([summarization, operationDeadline]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}

async function recordOperationalEvent(
  recorder: OperationalLogRecorder,
  event: OperationalLogEvent,
): Promise<void> {
  try {
    await recorder(event);
  } catch (error) {
    console.warn(
      "[summarization] operational event recorder failed:",
      sanitizeErrorForOps(error),
    );
  }
}

export async function summarizeOwnedFeedPeriod(
  database: Database,
  input: OwnedSummarizeFeedPeriodInput,
  dependencies: SummarizeFeedPeriodDependencies = {},
): Promise<PublicSummary> {
  dependencies.signal?.throwIfAborted();
  const summarizer = dependencies.summarizer ??
    new OpenAICompatibleSummarizerService();
  const config = getConfig();
  const nowFn = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? config.summarizerTimeoutMs;
  const operationalLog = dependencies.recordOperationalEvent ??
    appendOperationalLog;
  let itemCount: number | undefined;
  const onDiagnostic = async (diagnostic: SummarizationDiagnostic) => {
    await recordOperationalEvent(operationalLog, {
      level: diagnostic.event === "vision_unavailable" ? "warning" : "error",
      event: `summarization.${diagnostic.event}`,
      runId: dependencies.runId,
      feedId: input.feed.id,
      connectorId: input.connectorId,
      itemCount,
      chunkIndex: diagnostic.chunkIndex,
      chunkCount: diagnostic.chunkCount,
      model: diagnostic.model,
      errorMessage: diagnostic.errorMessage,
    });
  };

  const controller = new AbortController();
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
    itemCount = items.length;
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
          ? await summarizeWithDeadline(
            summarizer,
            [payload],
            rules,
            {
              signal: controller.signal,
              summaryMode: "article",
              onDiagnostic,
              maxTextBytesPerChunk: config.summarizerTextBytesPerChunk,
              maxItemsPerChunk: config.summarizerMaxItemsPerChunk,
              maxImageBytes: config.summarizerMaxImageBytes,
            },
            {
              requestTimeoutMs: timeoutMs,
              maxTextBytesPerChunk: config.summarizerTextBytesPerChunk,
            },
          )
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
      const normalizedItems = items.map((item) => item.payload);
      const points = normalizedItems.length === 0
        ? []
        : await summarizeWithDeadline(
          summarizer,
          normalizedItems,
          composeSummaryRuleset({
            connectorId: input.connectorId,
            kind: input.feed.kind,
            systemPrompt: input.user.systemPrompt,
            customPrompt: input.feed.customPrompt,
            language: input.user.defaultLanguage,
          }),
          {
            signal: controller.signal,
            onDiagnostic,
            maxTextBytesPerChunk: config.summarizerTextBytesPerChunk,
            maxItemsPerChunk: config.summarizerMaxItemsPerChunk,
            maxImageBytes: config.summarizerMaxImageBytes,
          },
          {
            requestTimeoutMs: timeoutMs,
            maxTextBytesPerChunk: config.summarizerTextBytesPerChunk,
          },
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
  } catch (error) {
    await recordOperationalEvent(operationalLog, {
      level: "error",
      event: "summarization.feed_failed",
      runId: dependencies.runId,
      feedId: input.feed.id,
      connectorId: input.connectorId,
      itemCount,
      errorMessage: sanitizeErrorForOps(error),
    });
    throw error;
  } finally {
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
