import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { test } from "bun:test";

import {
  xBrowserLaunchOptions,
  XBrowserSessions,
} from "../src/connectors/x/browser-session.ts";
import { assertEquals, assertRejects, assertStrictEquals } from "./assertions.ts";
import type { XChromeProcess } from "../src/connectors/x/chrome-process.ts";

const PROFILE_ID = "123e4567-e89b-42d3-a456-426614174000";

async function profileFixture(): Promise<{
  root: string;
  sessions: XBrowserSessions;
}> {
  const root = await mkdtemp(join(tmpdir(), "morning-post-x-session-"));
  await mkdir(join(root, PROFILE_ID), { mode: 0o700 });
  return {
    root,
    sessions: new XBrowserSessions(root, 1_000, "chromium"),
  };
}

test("X browser launch options preserve the selected browser and native credential store", () => {
  assertEquals(xBrowserLaunchOptions(false, "chrome", "darwin"), {
    headless: false,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: null,
    channel: "chrome",
    ignoreDefaultArgs: ["--use-mock-keychain"],
  });
  assertEquals(xBrowserLaunchOptions(true, "chrome", "darwin"), {
    headless: true,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
    channel: "chrome",
    ignoreDefaultArgs: ["--use-mock-keychain"],
  });
  assertEquals(xBrowserLaunchOptions(true, "chrome", "linux"), {
    headless: true,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
    channel: "chrome",
    ignoreDefaultArgs: ["--password-store=basic"],
  });
  assertEquals(xBrowserLaunchOptions(true, "chrome", "win32"), {
    headless: true,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
    channel: "chrome",
  });
  assertEquals(xBrowserLaunchOptions(false, "chromium", "darwin"), {
    headless: false,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: null,
  });
  assertEquals(xBrowserLaunchOptions(true, "chromium", "linux"), {
    headless: true,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
  });
});

test("unmanaged Chrome suppresses first-run prompts for its dedicated profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "morning-post-x-unmanaged-"));
  let resolveExit!: () => void;
  let running = true;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const process: XChromeProcess = {
    get running() {
      return running;
    },
    exited,
    async terminate() {
      running = false;
      resolveExit();
      await exited;
    },
  };
  let launch:
    | { executable: string; argv: readonly string[] }
    | undefined;
  const sessions = new XBrowserSessions(
    root,
    1_000,
    "chrome",
    "/standard/Google Chrome",
    async (executable, argv) => {
      launch = { executable, argv };
      return process;
    },
  );

  try {
    const session = await sessions.openUnmanaged(
      PROFILE_ID,
      "home",
    );
    assertEquals(launch, {
      executable: "/standard/Google Chrome",
      argv: [
        `--user-data-dir=${await realpath(join(root, PROFILE_ID))}`,
        "--no-first-run",
        "--no-default-browser-check",
        "https://x.com/home",
      ],
    });
    running = false;
    resolveExit();
    await session.waitForExit();
    assertStrictEquals(session.running, false);
    await sessions.removeProfile(PROFILE_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("unmanaged Chrome launch failure releases its profile lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "morning-post-x-launch-error-"));
  const sessions = new XBrowserSessions(
    root,
    1_000,
    "chrome",
    "/standard/Google Chrome",
    async () => {
      throw new Error("spawn failed");
    },
  );
  try {
    await assertRejects(
      () => sessions.openUnmanaged(PROFILE_ID, "home"),
      Error,
      "spawn failed",
    );
    await sessions.removeProfile(PROFILE_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("persistent X sessions fall back to Browser.close before releasing the profile lease", async () => {
  const fixture = await profileFixture();
  let contextCloseCalls = 0;

  try {
    await fixture.sessions.withHeadless(
      PROFILE_ID,
      undefined,
      async ({ context }) => {
        Object.defineProperty(context, "close", {
          configurable: true,
          value: async () => {
            contextCloseCalls += 1;
            throw new Error("context close failed");
          },
        });
      },
    );

    await fixture.sessions.withHeadless(
      PROFILE_ID,
      undefined,
      async () => undefined,
    );
    assertStrictEquals(contextCloseCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 30_000);

test("a later browser disconnect releases a lease retained after both close calls fail", async () => {
  const fixture = await profileFixture();
  const captured: {
    browser: Browser | null;
    closeBrowser: ((options?: { reason?: string }) => Promise<void>) | null;
  } = { browser: null, closeBrowser: null };
  try {
    await assertRejects(
      () =>
        fixture.sessions.withHeadless(
          PROFILE_ID,
          undefined,
          async ({ context }) => {
            const browser = context.browser();
            if (browser === null) throw new Error("persistent context has no browser");
            captured.browser = browser;
            captured.closeBrowser = browser.close.bind(browser);
            Object.defineProperty(context, "close", {
              configurable: true,
              value: async () => {
                throw new Error("context close failed");
              },
            });
            Object.defineProperty(browser, "close", {
              configurable: true,
              value: async () => {
                throw new Error("browser close failed");
              },
            });
          },
        ),
      AggregateError,
      "X persistent browser could not be closed",
    );

    if (captured.browser === null || captured.closeBrowser === null) {
      throw new Error("browser close function was not captured");
    }
    assertStrictEquals(captured.browser.isConnected(), true);
    await captured.closeBrowser({ reason: "test cleanup" });

    await fixture.sessions.withHeadless(
      PROFILE_ID,
      undefined,
      async () => undefined,
    );
  } finally {
    if (captured.browser?.isConnected() && captured.closeBrowser !== null) {
      await captured.closeBrowser({ reason: "test cleanup" }).catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 30_000);
