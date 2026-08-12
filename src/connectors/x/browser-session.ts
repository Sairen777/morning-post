import { chromium, errors } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { abortableDelay, abortReason, throwIfAborted } from "./abort.ts";
import type { XChromeProcess, XChromeProcessLauncher } from "./chrome-process.ts";
import {
  launchChromeProcess,
  resolveStableChromeExecutable,
} from "./chrome-process.ts";
import { X_ACCESSIBLE_NAMES } from "./dom-selectors.ts";
import { XProfileStore } from "./profile-store.ts";
import { acquireProfileLease } from "./profile-lease.ts";
import {
  assertXOrigin,
  formatXTargetUrl,
  X_CONTROL_URLS,
} from "./targets.ts";
import type { XBrowserChannel, XTarget } from "./x.types.ts";

const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 25_000;
const DOM_ACTION_TIMEOUT_MS = 8_000;
const TIMELINE_SWITCH_SETTLE_MS = 750;
const NAVIGATION_ATTEMPTS = 3;
const NAVIGATION_RETRY_DELAY_MS = 2_000;

export function xBrowserLaunchOptions(
  headless: boolean,
  browserChannel: XBrowserChannel,
  platform: NodeJS.Platform = process.platform,
) {
  const credentialStoreOverride = browserChannel === "chrome"
    ? platform === "darwin"
      ? "--use-mock-keychain"
      : platform === "linux"
      ? "--password-store=basic"
      : undefined
    : undefined;
  return {
    headless,
    acceptDownloads: false,
    locale: "en-US",
    timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    viewport: headless ? { width: 1280, height: 900 } : null,
    ...(browserChannel === "chrome" ? { channel: "chrome" as const } : {}),
    ...(credentialStoreOverride === undefined
      ? {}
      : { ignoreDefaultArgs: [credentialStoreOverride] }),
  };
}

export interface XOwnedBrowserSession {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface XUnmanagedBrowserSession {
  readonly running: boolean;
  waitForExit(): Promise<void>;
  close(): Promise<void>;
}

type XControlPage = keyof typeof X_CONTROL_URLS;
type XUnmanagedControlPage = "home" | "messages";

export class XBrowserSessions {
  private readonly profiles: XProfileStore;

  constructor(
    profileRoot: string,
    private readonly leaseTimeoutMs: number,
    private readonly browserChannel: XBrowserChannel,
    private readonly chromeExecutable?: string,
    private readonly chromeProcessLauncher: XChromeProcessLauncher = launchChromeProcess,
  ) {
    this.profiles = new XProfileStore(profileRoot);
  }

  public validateProfileId(profileId: string): void {
    this.profiles.pathFor(profileId);
  }

  public async withHeadless<T>(
    profileId: string,
    signal: AbortSignal | undefined,
    operation: (session: XOwnedBrowserSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.open(profileId, true, signal);
    try {
      return await operation(session);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      throw error;
    } finally {
      await session.close();
    }
  }

  public async openHeaded(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XOwnedBrowserSession> {
    return await this.open(profileId, false, signal);
  }

  public async openUnmanaged(
    profileId: string,
    control: XUnmanagedControlPage,
    signal?: AbortSignal,
  ): Promise<XUnmanagedBrowserSession> {
    throwIfAborted(signal);
    const profileKey = this.profiles.pathFor(profileId);
    const release = await acquireProfileLease(profileKey, this.leaseTimeoutMs, signal);
    let process: XChromeProcess | undefined;
    let closePromise: Promise<void> | undefined;
    let released = false;
    let onAbort: (() => void) | undefined;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort!);
      release();
    };
    const waitForExit = async () => {
      await process?.exited;
      releaseOnce();
    };
    const close = () => {
      if (released) return Promise.resolve();
      closePromise ??= (async () => {
        try {
          if (process === undefined) {
            releaseOnce();
            return;
          }
          await process.terminate();
          await process.exited;
          releaseOnce();
        } catch (error) {
          closePromise = undefined; // keep the lease; permit a later retry
          throw error;
        }
      })();
      return closePromise;
    };

    try {
      const profilePath = await this.profiles.ensure(profileId, signal);
      const executable = this.chromeExecutable ??
        await resolveStableChromeExecutable();
      process = await this.chromeProcessLauncher(executable, [
        `--user-data-dir=${profilePath}`,
        "--no-first-run",
        "--no-default-browser-check",
        X_CONTROL_URLS[control],
      ]);
      void waitForExit().catch(() => undefined);
      onAbort = () => {
        void close().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        await close();
        throw abortReason(signal);
      }
      return {
        get running() {
          return process?.running === true;
        },
        waitForExit,
        close,
      };
    } catch (error) {
      await close().catch(() => undefined);
      if (signal?.aborted) throw abortReason(signal);
      throw error;
    }
  }

  public async removeProfile(profileId: string, signal?: AbortSignal): Promise<void> {
    const profileKey = this.profiles.pathFor(profileId);
    const release = await acquireProfileLease(profileKey, this.leaseTimeoutMs, signal);
    try {
      await this.profiles.remove(profileId, signal);
    } finally {
      release();
    }
  }

  public async disconnectProfile<T>(
    profileId: string,
    mutation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const profileKey = this.profiles.pathFor(profileId);
    const release = await acquireProfileLease(profileKey, this.leaseTimeoutMs, signal);
    try {
      throwIfAborted(signal);
      const result = await mutation();
      await this.profiles.remove(profileId);
      return result;
    } finally {
      release();
    }
  }

  private async open(
    profileId: string,
    headless: boolean,
    signal?: AbortSignal,
  ): Promise<XOwnedBrowserSession> {
    throwIfAborted(signal);
    const profileKey = this.profiles.pathFor(profileId);
    const release = await acquireProfileLease(profileKey, this.leaseTimeoutMs, signal);
    let context: BrowserContext | undefined;
    let browser: Browser | null = null;
    let closePromise: Promise<void> | undefined;
    let closed = false;
    let released = false;
    let onAbort: (() => void) | undefined;
    let onBrowserDisconnected: (() => void) | undefined;

    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    const finishClosed = () => {
      if (closed) return;
      closed = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (onBrowserDisconnected) {
        browser?.off("disconnected", onBrowserDisconnected);
      }
      releaseOnce();
    };
    const close = () => {
      if (closed) return Promise.resolve();
      closePromise ??= (async () => {
        try {
          if (!context || context.isClosed()) {
            finishClosed();
            return;
          }

          let contextCloseError: unknown;
          try {
            await context.close({ reason: "X browser session finished" });
          } catch (error) {
            contextCloseError = error;
          }
          if (context.isClosed() || browser?.isConnected() === false) {
            finishClosed();
            return;
          }

          let browserCloseError: unknown;
          try {
            await browser?.close({ reason: "X browser session finished" });
          } catch (error) {
            browserCloseError = error;
          }
          if (context.isClosed() || browser?.isConnected() === false) {
            finishClosed();
            return;
          }

          throw new AggregateError(
            [contextCloseError, browserCloseError].filter(
              (error) => error !== undefined,
            ),
            "X persistent browser could not be closed",
          );
        } finally {
          if (!closed) closePromise = undefined;
        }
      })();
      return closePromise;
    };

    try {
      const profilePath = headless
        ? await this.profiles.requireExisting(profileId, signal)
        : await this.profiles.ensure(profileId, signal);
      context = await chromium.launchPersistentContext(
        profilePath,
        xBrowserLaunchOptions(headless, this.browserChannel),
      );
      browser = context.browser();
      onBrowserDisconnected = () => finishClosed();
      browser?.once("disconnected", onBrowserDisconnected);
      onAbort = () => {
        void close().catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        await close();
        throw abortReason(signal);
      }

      context.setDefaultTimeout(DOM_ACTION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

      const existingPages = context.pages();
      const page = await context.newPage();
      await Promise.all(existingPages.map(async (existingPage) => {
        await existingPage.close({ runBeforeUnload: false }).catch(() => undefined);
      }));
      throwIfAborted(signal);
      return { context, page, close };
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "X browser session failed and could not be closed",
        );
      }
      if (signal?.aborted) throw abortReason(signal);
      throw error;
    }
  }
}

export async function navigateXControl(
  page: Page,
  control: XControlPage,
  signal?: AbortSignal,
): Promise<void> {
  await navigateKnownXUrl(page, X_CONTROL_URLS[control], signal);
}

export async function navigateXTarget(
  page: Page,
  target: XTarget,
  signal?: AbortSignal,
): Promise<void> {
  await navigateKnownXUrl(page, formatXTargetUrl(target), signal);
}

export async function selectFollowingTimeline(page: Page, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const following = page.getByRole("tab", { name: X_ACCESSIBLE_NAMES.followingTab });
  await following.waitFor({ state: "visible", timeout: DOM_ACTION_TIMEOUT_MS });
  throwIfAborted(signal);
  if ((await following.getAttribute("aria-selected")) === "true") return;

  await following.click({ timeout: DOM_ACTION_TIMEOUT_MS });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[role="tab"]')).some((tab) =>
        tab.textContent?.trim().toLowerCase() === "following" &&
        tab.getAttribute("aria-selected") === "true"
      ),
    undefined,
    { timeout: DOM_ACTION_TIMEOUT_MS },
  );
  await abortableDelay(TIMELINE_SWITCH_SETTLE_MS, signal);
  if ((await following.getAttribute("aria-selected")) !== "true") {
    throw new Error("X Following timeline did not remain selected");
  }
  throwIfAborted(signal);
}

async function navigateKnownXUrl(page: Page, url: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      throwIfAborted(signal);
      assertXOrigin(page.url());
      if (response && response.status() >= 500) {
        throw new XNavigationResponseError(response.status());
      }
      return;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (
        attempt >= NAVIGATION_ATTEMPTS ||
        !isRetryableNavigationError(error)
      ) {
        throw error;
      }
      await page.goto("about:blank", {
        waitUntil: "domcontentloaded",
        timeout: DOM_ACTION_TIMEOUT_MS,
      }).catch(() => undefined);
      await abortableDelay(NAVIGATION_RETRY_DELAY_MS, signal);
    }
  }
}

class XNavigationResponseError extends Error {
  constructor(readonly status: number) {
    super(`X navigation returned HTTP ${status}`);
    this.name = "XNavigationResponseError";
  }
}

function isRetryableNavigationError(error: unknown): boolean {
  return error instanceof errors.TimeoutError ||
    error instanceof XNavigationResponseError;
}
