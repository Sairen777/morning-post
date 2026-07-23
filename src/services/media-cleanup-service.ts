import { readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CONNECTORS_MEDIA_DIR } from "../constants.ts";
import { sanitizeErrorForOps } from "../server/error-sanitizer.ts";

async function cleanupExpiredMediaInDirectory(
  directory: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await cleanupExpiredMediaInDirectory(path, now, ttlMs);
      try {
        await rm(path);
      } catch {
        // Keep non-empty or inaccessible directories.
      }
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const file = await stat(path);
      if (now - file.mtimeMs > ttlMs) await unlink(path);
    } catch (error: unknown) {
      console.warn(
        "[media-housekeeping] file removal error (non-fatal):",
        sanitizeErrorForOps(error),
      );
    }
  }
}

/** Best-effort removal of expired connector media, including orphaned files. */
export async function cleanupExpiredMedia(
  now: number,
  ttlMs: number,
  directories: readonly string[] = Object.values(CONNECTORS_MEDIA_DIR),
): Promise<void> {
  for (const directory of directories) {
    await cleanupExpiredMediaInDirectory(directory, now, ttlMs);
  }
}
