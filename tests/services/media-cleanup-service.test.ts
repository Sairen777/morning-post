import { test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects } from "../assertions.ts";
import { cleanupExpiredMedia } from "../../src/services/media-cleanup-service.ts";

test("cleanupExpiredMedia removes expired files recursively and preserves fresh files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morning-post-media-cleanup-"));
  const nested = join(directory, "nested");
  const expired = join(nested, "expired.jpg");
  const fresh = join(nested, "fresh.jpg");
  const now = 10_000;
  try {
    await mkdir(nested);
    await Promise.all([
      writeFile(expired, "expired"),
      writeFile(fresh, "fresh"),
    ]);
    await utimes(expired, 0, (now - 2_000) / 1_000);
    await utimes(fresh, 0, (now - 500) / 1_000);

    await cleanupExpiredMedia(now, 1_000, [directory]);

    await assertRejects(() => stat(expired), Error, "ENOENT");
    assertEquals((await stat(fresh)).isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanupExpiredMedia ignores missing directories", async () => {
  await cleanupExpiredMedia(Date.now(), 1_000, [
    join(tmpdir(), `morning-post-missing-${crypto.randomUUID()}`),
  ]);
});
