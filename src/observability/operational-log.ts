import { appendFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { isFileNotFoundError } from "../platform/filesystem-errors.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";

const DEFAULT_LOG_PATH = ".debug_logs/operations.jsonl";
const DEFAULT_MAXIMUM_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export type OperationalLogEventName =
  | "summarization.vision_unavailable"
  | "summarization.chunk_failed"
  | "summarization.merge_failed"
  | "summarization.feed_failed";

export interface OperationalLogEvent {
  level: "warning" | "error";
  event: OperationalLogEventName;
  runId?: string;
  feedId?: string;
  connectorId?: string;
  itemCount?: number;
  chunkIndex?: number;
  chunkCount?: number;
  model?: string;
  errorMessage: string;
}

export type OperationalLogRecorder = (
  event: OperationalLogEvent,
) => Promise<void>;

export interface OperationalLogOptions {
  path?: string;
  maximumBytes?: number;
  now?: () => number;
}

let pendingWrite = Promise.resolve();

export function appendOperationalLog(
  event: OperationalLogEvent,
  options: OperationalLogOptions = {},
): Promise<void> {
  const path = options.path ?? DEFAULT_LOG_PATH;
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  const now = options.now ?? Date.now;
  const write = pendingWrite.then(async () => {
    await writeOperationalLogLine(path, maximumBytes, {
      timestampMs: now(),
      ...event,
      errorMessage: sanitizeErrorForOps(event.errorMessage),
    });
  });
  pendingWrite = write.catch((error: unknown) => {
    console.warn(
      "[operations] local log write failed:",
      sanitizeErrorForOps(error),
    );
  });
  return pendingWrite;
}

async function writeOperationalLogLine(
  path: string,
  maximumBytes: number,
  event: { timestampMs: number } & OperationalLogEvent,
): Promise<void> {
  if (!Number.isFinite(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("Operational log maximum bytes must be positive");
  }

  const separatorIndex = path.lastIndexOf("/");
  const directory = separatorIndex === -1 ? "." : path.slice(0, separatorIndex);
  await mkdir(directory, { recursive: true });

  const line = encoder.encode(`${JSON.stringify(event)}\n`);
  const file = await open(path, "a+");
  let existingBytes: number;
  try {
    existingBytes = (await file.stat()).size;
  } finally {
    await file.close();
  }

  if (existingBytes > 0 && existingBytes + line.byteLength > maximumBytes) {
    const rotatedPath = `${path}.1`;
    await unlink(rotatedPath).catch((error: unknown) => {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    });
    await rename(path, rotatedPath);

  }

  await appendFile(path, line);
}
