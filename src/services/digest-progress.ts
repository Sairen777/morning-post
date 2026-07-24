export type DigestProgressEvent =
  | { event: "run_start"; runId: string; elapsedMs: number; status: "running" }
  | { event: "ingestion_source"; runId: string; elapsedMs: number; sourceIndex: number; sourceCount: number; feedCount: number; status: "started" | "complete" | "failed" }
  | { event: "ingestion_feed"; runId: string; elapsedMs: number; sourceIndex: number; feedIndex: number; feedCount: number; itemCount: number; status: "complete" | "failed" | "skipped" }
  | { event: "analysis_checkpoint"; runId: string; elapsedMs: number; batchIndex: number; batchSize: number; completedCount: number; totalCount: number; status: "started" | "complete" }
  | { event: "resolution"; runId: string; elapsedMs: number; itemCount: number; status: "started" | "complete" }
  | { event: "classification"; runId: string; elapsedMs: number; itemCount: number; status: "started" | "complete" }
  | { event: "summarization"; runId: string; elapsedMs: number; itemCount: number; completedCount: number; status: "started" | "complete" }
  | { event: "run_terminal"; runId: string; elapsedMs: number; status: "complete" | "partial" | "failed" };

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
