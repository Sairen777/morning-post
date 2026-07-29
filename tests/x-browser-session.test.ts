import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { test } from "bun:test";

import {
  xBrowserLaunchOptions,
  XBrowserSessions,
} from "../src/connectors/x/browser-session.ts";
import { assertEquals, assertRejects, assertStrictEquals } from "./assertions.ts";

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

test("X browser launch options select stable Chrome only for headed sessions", () => {
  assertEquals(xBrowserLaunchOptions(false, "chrome"), {
    headless: false,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: null,
    channel: "chrome",
  });
  assertEquals(xBrowserLaunchOptions(true, "chrome"), {
    headless: true,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: { width: 1280, height: 900 },
  });
  assertEquals(xBrowserLaunchOptions(false, "chromium"), {
    headless: false,
    acceptDownloads: false,
    locale: "en-US",
    timeout: 30_000,
    viewport: null,
  });
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
