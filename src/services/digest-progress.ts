import type { ModelAttemptTelemetry } from "../summarizers/openai-compatible-client.ts";

export type DigestModelStage =
  | "analysis"
  | "classification"
  | "summarization"
  | "media";

export interface DigestModelUsageMetrics {
  attemptCount: number;
  durationMs: number;
  usageReportedAttemptCount: number;
  promptTokensLowerBound: number;
  completionTokensLowerBound: number;
  totalTokensLowerBound: number;
  promptCacheHitTokensLowerBound: number;
  promptCacheMissTokensLowerBound: number;
  successCount: number;
  retryCount: number;
  failureCount: number;
  saturated: boolean;
}

export interface DigestModelUsageAggregate extends DigestModelUsageMetrics {}

export interface DigestModelUsageSnapshot {
  version: 1;
  totals: DigestModelUsageMetrics;
  stages: Array<{
    stage: DigestModelStage;
    models: Array<{ model: string; metrics: DigestModelUsageMetrics }>;
  }>;
  estimatedCostUsd: number | null;
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

const metricFields = [
  "attemptCount",
  "durationMs",
  "usageReportedAttemptCount",
  "promptTokensLowerBound",
  "completionTokensLowerBound",
  "totalTokensLowerBound",
  "promptCacheHitTokensLowerBound",
  "promptCacheMissTokensLowerBound",
  "successCount",
  "retryCount",
  "failureCount",
] as const;

function emptyMetrics(): DigestModelUsageMetrics {
  return Object.fromEntries(metricFields.map((field) => [field, 0])) as unknown as
    DigestModelUsageMetrics & { saturated: boolean };
}
const aggregateBreakdowns = new WeakMap<
  DigestModelUsageAggregate,
  Partial<Record<DigestModelStage, Record<string, DigestModelUsageMetrics>>>
>();

function addToAggregate(
  aggregate: DigestModelUsageMetrics,
  field: (typeof metricFields)[number],
  increment: number,
): void {
  const current = aggregate[field] ?? 0;
  if (current > Number.MAX_SAFE_INTEGER - increment) {
    aggregate[field] = Number.MAX_SAFE_INTEGER;
    aggregate.saturated = true;
    return;
  }
  aggregate[field] = current + increment;
}

function recordAttempt(
  aggregate: DigestModelUsageMetrics,
  attempt: ModelAttemptTelemetry,
): void {
  addToAggregate(aggregate, "attemptCount", 1);
  addToAggregate(aggregate, "durationMs", attempt.durationMs);
  addToAggregate(aggregate, `${attempt.status}Count`, 1);
  if (!attempt.usage) return;
  addToAggregate(aggregate, "usageReportedAttemptCount", 1);
  addToAggregate(aggregate, "promptTokensLowerBound", attempt.usage.promptTokens);
  addToAggregate(aggregate, "completionTokensLowerBound", attempt.usage.completionTokens);
  addToAggregate(aggregate, "totalTokensLowerBound", attempt.usage.totalTokens);
  addToAggregate(aggregate, "promptCacheHitTokensLowerBound", attempt.usage.promptCacheHitTokens ?? 0);
  addToAggregate(aggregate, "promptCacheMissTokensLowerBound", attempt.usage.promptCacheMissTokens ?? 0);
}

export function createDigestModelUsageAggregate(): DigestModelUsageAggregate {
  const aggregate = { ...emptyMetrics(), saturated: false };
  aggregateBreakdowns.set(aggregate, {});
  return aggregate;
}

export function snapshotDigestModelUsage(
  aggregate: DigestModelUsageAggregate,
): DigestModelUsageSnapshot {
  const metricSnapshot = (metrics: DigestModelUsageMetrics): DigestModelUsageMetrics =>
    Object.fromEntries([
      ...metricFields.map((field) => [field, metrics[field] ?? 0]),
      ["saturated", metrics.saturated],
    ]) as unknown as DigestModelUsageMetrics;
  return {
    version: 1,
    totals: metricSnapshot(aggregate),
    stages: Object.entries(aggregateBreakdowns.get(aggregate) ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stage, models]) => ({
        stage: stage as DigestModelStage,
        models: Object.entries(models ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([model, metrics]) => ({ model, metrics: metricSnapshot(metrics) })),
      })),
    estimatedCostUsd: null,
  };
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
    const tracksExtendedMetrics = Object.hasOwn(aggregate, "successCount");
    recordAttempt(aggregate, attempt);
    if (!tracksExtendedMetrics) {
      delete (aggregate as Partial<DigestModelUsageMetrics>).promptCacheHitTokensLowerBound;
      delete (aggregate as Partial<DigestModelUsageMetrics>).promptCacheMissTokensLowerBound;
      delete (aggregate as Partial<DigestModelUsageMetrics>).successCount;
      delete (aggregate as Partial<DigestModelUsageMetrics>).retryCount;
      delete (aggregate as Partial<DigestModelUsageMetrics>).failureCount;
    }
    let breakdown = aggregateBreakdowns.get(aggregate);
    if (!breakdown) {
      breakdown = {};
      aggregateBreakdowns.set(aggregate, breakdown);
    }
    const models = breakdown[stage] ??= {};
    const model = attempt.model ?? "unknown";
    const modelMetrics = models[model] ??= { ...emptyMetrics(), saturated: false };
    recordAttempt(modelMetrics, attempt);
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
