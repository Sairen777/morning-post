import { test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { XBrowserSessions } from "../src/connectors/x/browser-session.ts";
import { XProfileStore } from "../src/connectors/x/profile-store.ts";
import {
  assertEquals,
  assertRejects,
} from "./assertions.ts";

const PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";

async function temporaryProfileRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "morning-post-x-profile-"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("headless profile lookup never creates a missing managed profile", async () => {
  const root = await temporaryProfileRoot();
  try {
    const store = new XProfileStore(root);
    const profilePath = store.pathFor(PROFILE_ID);

    await assertRejects(
      () => store.requireExisting(PROFILE_ID),
      Error,
      undefined,
    );
    assertEquals(await pathExists(profilePath), false);

    assertEquals(await store.ensure(PROFILE_ID), profilePath);
    assertEquals((await stat(profilePath)).mode & 0o777, 0o700);
    assertEquals(await store.requireExisting(PROFILE_ID), profilePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed profiles reject symlink substitution and unlink only the profile link", async () => {
  const root = await temporaryProfileRoot();
  const external = await mkdtemp(join(tmpdir(), "morning-post-x-external-"));
  try {
    const store = new XProfileStore(root);
    const profilePath = store.pathFor(PROFILE_ID);
    const sentinel = join(external, "sentinel.txt");
    await writeFile(sentinel, "keep me");
    await symlink(external, profilePath, "dir");

    await assertRejects(
      () => store.requireExisting(PROFILE_ID),
      Error,
      "not a link",
    );
    await store.remove(PROFILE_ID);

    assertEquals(await pathExists(profilePath), false);
    assertEquals(await readFile(sentinel, "utf8"), "keep me");
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  }
});

test("disconnect preserves the profile on mutation failure and ignores abort after commit", async () => {
  const root = await temporaryProfileRoot();
  try {
    const sessions = new XBrowserSessions(root, 1_000);
    const profilePath = join(root, PROFILE_ID);
    await mkdir(profilePath, { mode: 0o700 });

    await assertRejects(
      () =>
        sessions.disconnectProfile(PROFILE_ID, () =>
          Promise.reject(new Error("database mutation failed"))
        ),
      Error,
      "database mutation failed",
    );
    assertEquals((await lstat(profilePath)).isDirectory(), true);

    const controller = new AbortController();
    const result = await sessions.disconnectProfile(PROFILE_ID, async () => {
      controller.abort(new DOMException("request ended", "AbortError"));
      return "disconnected";
    }, controller.signal);

    assertEquals(result, "disconnected");
    assertEquals(await pathExists(profilePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
