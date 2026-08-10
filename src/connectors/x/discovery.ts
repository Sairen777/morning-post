import type { Page } from "playwright";

import type { AvailableFeed } from "../connector.types.ts";
import { navigateXControl } from "./browser-session.ts";
import { requireXAuthentication, requireXChatUnlocked } from "./connection-state.ts";
import { extractLinks } from "./dom-extractors.ts";
import type { XDomLink } from "./dom-extractors.ts";
import { X_DOM } from "./dom-selectors.ts";
import {
  formatXFeedExternalId,
  parseXTargetUrl,
  X_ORIGIN,
} from "./targets.ts";
import type { XTarget } from "./x.types.ts";
import { collectVirtualizedItems } from "./virtual-scroll.ts";
import type { XVirtualScrollStopReason } from "./virtual-scroll.ts";

const MAX_DISCOVERY_ROUNDS = 32;
const MAX_DISCOVERED_LINKS = 250;

// Discovery may complete only on a proven finish: the caller's `condition` or
// a `boundary` where scrolling genuinely stopped moving. Every safety stop
// (`max_rounds`, `max_items`, and the repeated-window `no_progress`) leaves
// the rendered window unproven and must fail discovery closed so the
// collection cursor never advances past an incomplete window.
const COMPLETE_DISCOVERY_STOP_REASONS: Readonly<Record<string, true>> = {
  condition: true,
  boundary: true,
};

export async function discoverXFeedsOnPage(
  page: Page,
  signal?: AbortSignal,
): Promise<AvailableFeed[]> {
  const feeds: AvailableFeed[] = [{
    externalId: "x:following",
    name: "Following",
    kind: "news",
  }];

  await navigateXControl(page, "home", signal);
  await requireXAuthentication(page, signal);

  await navigateXControl(page, "lists", signal);
  await requireXAuthentication(page, signal);
  const listLinks = await collectDiscoveryLinks(page, X_DOM.listLink, signal);
  feeds.push(...toAvailableFeeds(listLinks, "list"));

  await navigateXControl(page, "messages", signal);
  await requireXAuthentication(page, signal);
  await requireXChatUnlocked(page, signal);
  const chatLinks = await collectDiscoveryLinks(page, X_DOM.conversationLink, signal);
  feeds.push(...toAvailableFeeds(chatLinks, "chat"));

  return mergeDiscoveredFeeds(feeds);
}

async function collectDiscoveryLinks(
  page: Page,
  selector: string,
  signal?: AbortSignal,
): Promise<XDomLink[]> {
  const collection = await collectVirtualizedItems(page, {
    itemSelector: selector,
    direction: "down",
    extractRound: async () => await extractLinks(page, selector),
    identityOf: (link) => link.href,
    maxRounds: MAX_DISCOVERY_ROUNDS,
    maxItems: MAX_DISCOVERED_LINKS,
  }, signal);
  const stopError = discoveryStopError(collection.stopReason);
  if (stopError) throw stopError;
  return collection.items;
}

/**
 * Maps a virtual-scroll stop reason to the error that must fail discovery, or
 * null when the stop is a proven completion (`condition` or `boundary`).
 * `no_progress` and every other safety stop fail closed by not being listed
 * among the proven completions.
 */
export function discoveryStopError(
  stopReason: XVirtualScrollStopReason,
): Error | null {
  if (COMPLETE_DISCOVERY_STOP_REASONS[stopReason] === true) return null;
  return new Error("X feed discovery reached a safety limit before completion");
}

/**
 * Maps rendered DOM links to available feeds of one expected kind. Links are
 * canonicalized to same-origin supported X paths only, names are cleaned, and
 * every accepted feed is keyed by its canonical `x:list:`/`x:chat:` external
 * ID without inferring any conversation structure from the ID shape.
 */
export function toAvailableFeeds(
  links: readonly XDomLink[],
  expectedKind: "list" | "chat",
): AvailableFeed[] {
  const feeds: AvailableFeed[] = [];
  for (const link of links) {
    const target = canonicalTargetFromLink(link.href);
    if (!target || target.kind !== expectedKind) continue;
    const externalId = formatXFeedExternalId(target);
    feeds.push({
      externalId,
      name: cleanFeedName(link.name) || fallbackName(target),
      kind: target.kind === "chat" ? "discussion" : "news",
    });
  }
  return feeds;
}

/**
 * Canonicalizes a rendered link to its X target. Only same-origin links whose
 * path is a supported canonical X target are accepted; control-page paths,
 * malformed URLs, and links containing control characters yield null. Query
 * strings and fragments are stripped before the canonical path shape is
 * enforced by the centralized target parser.
 */
export function canonicalTargetFromLink(href: string): XTarget | null {
  // Reject control characters before URL parsing: the WHATWG parser silently
  // strips trailing NULs and tabs/newlines, which would otherwise smuggle
  // malformed rendered links past the canonical path check.
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const url = new URL(href, X_ORIGIN);
    if (url.origin !== X_ORIGIN) return null;
    return parseXTargetUrl(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

/**
 * Deduplicates discovered feeds by canonical external ID, preferring the first
 * rendered name over the ID-derived fallback, then orders the Following feed
 * first, news (lists) before discussions (chats), and otherwise by name.
 */
export function mergeDiscoveredFeeds(
  feeds: readonly AvailableFeed[],
): AvailableFeed[] {
  const byExternalId = new Map<string, AvailableFeed>();
  for (const feed of feeds) {
    const previous = byExternalId.get(feed.externalId);
    if (
      !previous ||
      previous.name === fallbackNameForExternalId(previous.externalId)
    ) {
      byExternalId.set(feed.externalId, feed);
    }
  }
  return Array.from(byExternalId.values()).sort((left, right) => {
    if (left.externalId === "x:following") return -1;
    if (right.externalId === "x:following") return 1;
    if (left.kind !== right.kind) return left.kind === "news" ? -1 : 1;
    return left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId);
  });
}

export function cleanFeedName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function fallbackName(target: XTarget): string {
  switch (target.kind) {
    case "following":
      return "Following";
    case "list":
      return `List ${target.listId}`;
    case "chat":
      return `Chat ${target.conversationId}`;
  }
}

function fallbackNameForExternalId(externalId: string): string {
  if (externalId === "x:following") return "Following";
  const target = externalId.startsWith("x:list:")
    ? { kind: "list" as const, listId: externalId.slice("x:list:".length) }
    : { kind: "chat" as const, conversationId: externalId.slice("x:chat:".length) };
  return fallbackName(target);
}
