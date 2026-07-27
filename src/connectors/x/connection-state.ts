import type { Page } from "playwright";

import { abortableDelay, throwIfAborted } from "./abort.ts";
import { navigateXControl } from "./browser-session.ts";
import {
  isAuthenticatedMarkerVisible,
  isChatShellVisible,
  isChatUnlockVisible,
  isLoginVisible,
} from "./dom-extractors.ts";
import { X_DOM } from "./dom-selectors.ts";
import { assertXOrigin } from "./targets.ts";
import type { XLoginState } from "./x.types.ts";

const STATE_ATTEMPTS = 24;
const STATE_POLL_INTERVAL_MS = 250;

export async function inspectXConnectionState(
  page: Page,
  signal?: AbortSignal,
): Promise<XLoginState> {
  await navigateXControl(page, "home", signal);
  if (!(await waitForAuthentication(page, signal))) return "awaiting_login";

  await navigateXControl(page, "messages", signal);
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    assertXOrigin(page.url());
    if (isLoginPath(page.url()) || await isLoginVisible(page)) return "awaiting_login";
    if (await isChatUnlockVisible(page)) return "awaiting_chat_unlock";
    if (await isChatShellVisible(page)) return "complete";
    await abortableDelay(STATE_POLL_INTERVAL_MS, signal);
  }
  throw new Error("X Chat connection state did not become inspectable before the deadline");
}

export async function requireXAuthentication(page: Page, signal?: AbortSignal): Promise<void> {
  if (await waitForAuthentication(page, signal)) return;
  throw new Error("X profile is not authenticated");
}

export async function requireXChatUnlocked(page: Page, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    assertXOrigin(page.url());
    if (isLoginPath(page.url()) || await isLoginVisible(page)) {
      throw new Error("X profile is not authenticated");
    }
    if (await isChatUnlockVisible(page)) {
      throw new Error("X Chat must be visibly unlocked before collection");
    }
    if (await isChatShellVisible(page) || await page.locator(X_DOM.chatMessage).count() > 0) return;
    await abortableDelay(STATE_POLL_INTERVAL_MS, signal);
  }
  throw new Error("X Chat did not become ready before the deadline");
}

async function waitForAuthentication(page: Page, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < STATE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    assertXOrigin(page.url());
    if (isLoginPath(page.url()) || await isLoginVisible(page)) return false;
    if (await isAuthenticatedMarkerVisible(page)) {
      return true;
    }
    await abortableDelay(STATE_POLL_INTERVAL_MS, signal);
  }
  throw new Error("X authentication state did not become inspectable before the deadline");
}

function isLoginPath(value: string): boolean {
  const path = new URL(value).pathname;
  return path === "/login" || path.startsWith("/i/flow/login");
}
