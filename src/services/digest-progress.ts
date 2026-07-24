import type { ModelAttemptTelemetry } from "../summarizers/openai-compatible-client.ts";

export type DigestModelStage =
  | "analysis"
  | "classification"
  | "summarization"
  | "media";

export interface DigestModelUsageAggregate {
  attemptCount: number;
  durationMs: number;
  usageReportedAttemptCount: number;
  promptTokensLowerBound: number;
  completionTokensLowerBound: number;
  totalTokensLowerBound: number;
  saturated: boolean;
}

export type DigestProgressEvent =
  | { event: "run_start"; runId: string; elapsedMs: number; status: "running" }
  | { event: "ingestion_source"; runId: string; elapsedMs: number; sourceIndex: number; sourceCount: number; feedCount: number; status: "started" | "complete" | "failed" }
  | { event: "ingestion_feed"; runId: string; elapsedMs: number; sourceIndex: number; feedIndex: number; feedCount: number; itemCount: number; status: "complete" | "failed" | "skipped" }
  | { event: "analysis_checkpoint"; runId: string; elapsedMs: number; batchIndex: number; batchSize: number; completedCount: number; totalCount: number; status: "started" | "complete" }
  | { event: "resolution"; runId: string; elapsedMs: number; itemCount: number; status: "started" | "complete" }
  | { event: "classification"; runId: string; elapsedMs: number; itemCount: number; status: "started" | "complete" }
  | { event: "summarization"; runId: string; elapsedMs: number; itemCount: number; completedCount: number; status: "started" | "complete" }
  | { event: "model_attempt"; runId: string; elapsedMs: number; stage: DigestModelStage; attempt: number; durationMs: number; status: "success" | "retry" | "failure"; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { event: "run_terminal"; runId: string; elapsedMs: number; status: "complete" | "partial" | "failed"; modelAttemptCount: number; modelDurationMs: number; usageReportedAttemptCount: number; promptTokensLowerBound: number; completionTokensLowerBound: number; totalTokensLowerBound: number; modelMetricsSaturated: boolean };

export interface DigestProgressReporter {
  report(event: DigestProgressEvent): void;
}

export type DigestProgressLog = (record: string) => void;

export function createConsoleDigestProgressReporter(
  enabled: boolean,
  log: DigestProgressLog = console.info,
): DigestProgressReporter | undefined {
  if (!enabled) return undefined;
  return { report: (event) => log(JSON.stringify(event)) };
}

export function reportDigestProgress(
  reporter: DigestProgressReporter | undefined,
  event: DigestProgressEvent,
): void {
  if (!reporter) return;
  try {
    reporter.report(event);
  } catch {
    // Progress is observational and must never affect digest execution.
  }
}

function addToAggregate(
  aggregate: DigestModelUsageAggregate,
  field: Exclude<keyof DigestModelUsageAggregate, "saturated">,
  increment: number,
): void {
  if (aggregate[field] > Number.MAX_SAFE_INTEGER - increment) {
    aggregate[field] = Number.MAX_SAFE_INTEGER;
    aggregate.saturated = true;
    return;
  }
  aggregate[field] += increment;
}

export function reportDigestModelAttempt(
  reporter: DigestProgressReporter | undefined,
  runId: string | undefined,
  elapsedMs: number,
  stage: DigestModelStage,
  aggregate: DigestModelUsageAggregate | undefined,
  attempt: ModelAttemptTelemetry,
): void {
  if (aggregate) {
    addToAggregate(aggregate, "attemptCount", 1);
    addToAggregate(aggregate, "durationMs", attempt.durationMs);
    if (attempt.usage) {
      addToAggregate(aggregate, "usageReportedAttemptCount", 1);
      addToAggregate(aggregate, "promptTokensLowerBound", attempt.usage.promptTokens);
      addToAggregate(aggregate, "completionTokensLowerBound", attempt.usage.completionTokens);
      addToAggregate(aggregate, "totalTokensLowerBound", attempt.usage.totalTokens);
    }
  }
  if (!runId) return;
  reportDigestProgress(reporter, {
    event: "model_attempt",
    runId,
    elapsedMs,
    stage,
    attempt: attempt.attempt,
    durationMs: attempt.durationMs,
    status: attempt.status,
    ...(attempt.usage && {
      promptTokens: attempt.usage.promptTokens,
      completionTokens: attempt.usage.completionTokens,
      totalTokens: attempt.usage.totalTokens,
    }),
  });
}
