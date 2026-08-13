import type { Page } from "playwright";

import { X_ACCESSIBLE_NAMES, X_DOM, X_VISIBLE_TEXT } from "./dom-selectors.ts";
import type { XReaction } from "./x.types.ts";

export interface XDomTimelineItem {
  platformId: string | null;
  date: number | null;
  text: string;
  author: string | null;
  url: string | null;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
  viewCount: number | null;
}

export interface XDomChatMessage {
  platformId: string | null;
  /**
   * Internal stable collection/persistence identity. Modern rows use their
   * UUID; accepted legacy rows use a distinct `legacy:` namespace. Missing
   * or null means the rendered row cannot be safely deduplicated.
   */
  readonly identityKey?: string | null;
  date: number | null;
  text: string;
  author: string | null;
  reactions: XReaction[];
  /** Present only when geometry proves this message was sent by the viewer. */
  viewerAuthored?: true;
}

export interface XChatBounds {
  lower: number | null;
  upper: number | null;
}

export interface XChatMessageExtractor {
  (): Promise<XDomChatMessage[]>;
  boundsOf(item: XDomChatMessage): XChatBounds;
  completeTopBoundary(): Promise<void>;
}

export interface XDomLink {
  href: string;
  name: string;
}

export async function extractTimelineItems(page: Page): Promise<XDomTimelineItem[]> {
  const values = await page.locator(X_DOM.timelinePost).evaluateAll((elements, selectors) => {
    const textOf = (element: Element | null) => {
      if (!element) return "";
      const value = element instanceof HTMLElement ? element.innerText : element.textContent;
      return (value ?? "").replace(/\s+/g, " ").trim();
    };
    const compactCount = (element: Element | null) => {
      if (!element) return null;
      const raw = `${element.getAttribute("aria-label") ?? ""} ${textOf(element)}`;
      const match = raw.match(/(\d[\d.,]*)(?:\s*)([KMB])?/i);
      if (!match) return null;
      const suffix = match[2]?.toUpperCase();
      let numericText = match[1];
      if (suffix) {
        numericText = numericText.replace(",", ".").replace(/\.(?=.*\.)/g, "");
      } else {
        numericText = numericText.replace(/[.,]/g, "");
      }
      const numeric = Number.parseFloat(numericText);
      if (!Number.isFinite(numeric)) return null;
      const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
      return Math.max(0, Math.round(numeric * multiplier));
    };
    const authorOf = (entry: Element) => {
      const userName = entry.querySelector(selectors.userName);
      if (!userName) return null;
      for (const anchor of userName.querySelectorAll("a[href]")) {
        const href = anchor.getAttribute("href") ?? "";
        const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
        if (match) return `@${match[1]}`;
      }
      const lines = (userName instanceof HTMLElement ? userName.innerText : userName.textContent ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.find((line) => line.startsWith("@")) ?? lines[0] ?? null;
    };

    return elements.map((entry) => {
      const time = entry.querySelector(selectors.time)?.getAttribute("datetime") ?? null;
      const parsedDate = time === null ? Number.NaN : Date.parse(time);
      let platformId: string | null = null;
      let canonicalUrl: string | null = null;
      for (const anchor of entry.querySelectorAll(selectors.statusLink)) {
        const href = anchor.getAttribute("href");
        if (!href) continue;
        try {
          const candidate = new URL(href, "https://x.com");
          if (candidate.origin !== "https://x.com") continue;
          const match = /^\/(?:([A-Za-z0-9_]{1,15})|i\/web)\/status\/([1-9]\d{0,31})(?:\/.*)?$/.exec(candidate.pathname);
          if (!match) continue;
          platformId = match[2];
          canonicalUrl = match[1]
            ? `https://x.com/${match[1]}/status/${match[2]}`
            : `https://x.com/i/web/status/${match[2]}`;
          break;
        } catch {
          // Ignore malformed hrefs rendered by extensions or transient UI.
        }
      }
      return {
        platformId,
        date: Number.isFinite(parsedDate) ? parsedDate : null,
        text: textOf(entry.querySelector(selectors.text)),
        author: authorOf(entry),
        url: canonicalUrl,
        replyCount: compactCount(entry.querySelector(selectors.reply)),
        repostCount: compactCount(entry.querySelector(selectors.repost)),
        likeCount: compactCount(entry.querySelector(selectors.like)),
        viewCount: compactCount(entry.querySelector(selectors.view)),
      };
    });
  }, {
    text: X_DOM.postText,
    time: X_DOM.postTime,
    statusLink: X_DOM.postStatusLink,
    userName: X_DOM.userName,
    reply: X_DOM.replyMetric,
    repost: X_DOM.repostMetric,
    like: X_DOM.likeMetric,
    view: X_DOM.viewMetric,
  });
  return values as XDomTimelineItem[];
}

interface ExtractedChatRow {
  kind?: "modern" | "legacy";
  platformId: string | null;
  date: number | null;
  time: { hours: number; minutes: number } | null;
  text: string;
  author: string | null;
  reactions: XReaction[];
  top: number;
  order: number;
  /** Modern rows only: defensible bubble side from row-owned geometry. */
  side?: "incoming" | "outgoing" | null;
  /** Modern rows only: short sender label paired immediately before the row/body. */
  senderLabel?: string | null;
  /** Modern rows only: exact avatar profile handle inside this row's avatar subtree. */
  avatarHandle?: string | null;
  /** Modern rows only: prior row UUID when the DOM proves direct visual continuity. */
  continuesPreviousUuid?: string | null;
}

interface ChatLocalDay {
  year: number;
  month: number;
  day: number;
  /** Browser-local midnight of this day as an epoch ms, derived inside Chromium. */
  midnight: number;
}

interface ExtractedChatRound {
  rows: ExtractedChatRow[];
  separators: Array<{ top: number; order: number; day: ChatLocalDay }>;
}

interface RetainedChatRecord {
  record: XDomChatMessage;
  time: { hours: number; minutes: number } | null;
  exactDate: number | null;
  avatarHandle: string | null;
  avatarHandleConflicted: boolean;
  senderLabel: string | null;
  senderLabelConflicted: boolean;
  side: "incoming" | "outgoing" | null;
  sideConflicted: boolean;
  bounds: XChatBounds;
  legacy: boolean;
}

type ChatOrderItem =
  | { kind: "day"; key: string; day: ChatLocalDay }
  | { kind: "row"; uuid: string };

const X_MODERN_MESSAGE_ROW = /^message-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// Same-origin status anchors backing shared-post rows: exactly
// /<handle>/status/<numeric-id> after query/hash stripping.
const X_STATUS_ANCHOR = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,31})$/;
// Same-origin single-segment profile links (avatars): exactly /<handle>.
const X_PROFILE_LINK = /^\/[A-Za-z0-9_]{1,15}$/;
const X_BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
// Link-card rows can carry arbitrary non-status anchors and no body/media
// marker. Their content remains unavailable, but the visible card itself is
// representable without ingesting its preview prose.
const X_LINK_CARD_TEXT = "[Link]";
// One to sixteen rendered emoji graphemes. This is intentionally stricter
// than the reaction parser: it certifies only an emoji-only message bubble,
// never arbitrary prose that happens to contain an emoji.
const X_EMOJI_ONLY = /^(?:(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)){1,16}$/u;
const X_DATE_SEPARATOR = /^(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+\d{4})?)$/i;
const X_VISIBLE_TIME = /^(1[0-2]|0?[1-9]):([0-5]\d)\s*([AP]M)$/i;
const X_BARE_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const X_MONTH_DAY = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i;
const X_WEEKDAYS: Record<string, number | undefined> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const X_MONTH_INDEX_BY_NAME: Record<string, number | undefined> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const X_CHAT_EXTRACT_KEYS = Object.freeze({
  chatMessage: X_DOM.chatMessage,
  scroller: X_DOM.chatMessageScroller,
  body: X_DOM.chatMessageBody,
  bodyText: X_DOM.chatMessageBodyText,
  text: X_DOM.chatMessageText,
  userName: X_DOM.userName,
  reaction: X_DOM.chatReaction,
  modernRow: X_MODERN_MESSAGE_ROW,
  // Modern message rows as a CSS selector for structural ownership checks
  // (nearest-row and avatar-subtree predicates inside richBodyOf).
  row: X_DOM.chatMessageRow,
  avatar: '[data-testid^="message-avatar-"]',
  // Any message-* test id (rows, bodies, avatars) inside a label candidate
  // disqualifies it: paired sender labels are text-only wrappers.
  messageTestId: '[data-testid^="message-"]',
  // Legacy row shapes that must never act as sender labels.
  messageRowLike: '[data-testid="messageEntry"], [data-message-id], [data-event-id]',
  // Media and interactive decoys never become sender labels.
  labelMedia: 'img, video, audio',
  labelInteractive: 'button, [role="button"], input, select, textarea, [contenteditable="true"]',
  statusAnchor: X_STATUS_ANCHOR,
  profileLink: X_PROFILE_LINK,
  bidiControl: X_BIDI_CONTROL,
  emojiOnly: X_EMOJI_ONLY,
  dateSeparator: X_DATE_SEPARATOR,
  visibleTime: X_VISIBLE_TIME,
  bareTime: X_BARE_TIME,
  monthDay: X_MONTH_DAY,
  weekdays: X_WEEKDAYS,
  monthIndexByName: X_MONTH_INDEX_BY_NAME,
  linkCardText: X_LINK_CARD_TEXT,
});

const dayKeyOf = (day: ChatLocalDay): string => `${day.year}-${day.month}-${day.day}`;
// Midnight is resolved inside Chromium when the separator's calendar day is
// parsed, so separator bounds never depend on this process's timezone.
const dayMidnightOf = (day: ChatLocalDay): number => day.midnight;

function stableLegacyChatId(value: string | null): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  return value;
}

function withChatIdentity(
  record: Omit<XDomChatMessage, "identityKey">,
  identityKey: string | null,
): XDomChatMessage {
  Object.defineProperty(record, "identityKey", {
    value: identityKey,
    enumerable: false,
  });
  return record;
}

export function createChatMessageExtractor(
  page: Page,
): XChatMessageExtractor {
  const retainedByUuid = new Map<string, RetainedChatRecord>();
  const order: ChatOrderItem[] = [];
  // A continuity edge is recorded only when two modern incoming rows have
  // directly adjacent row hosts and touching geometry in the same rendered
  // round. Exact sender labels can then propagate through overlapping
  // windows without crossing a filtered, legacy, outgoing, or unseen row.
  const incomingContinuity = new Set<string>();
  const continuityKeyOf = (left: string, right: string): string =>
    `${left}\u0000${right}`;
  const knownDayKeys = new Set<string>();
  // Day keys whose sole-separator classification proved a strict minutes
  // descent (11:59 PM above, 12:00 AM below): only those separators carry
  // verified midnight-boundary evidence for the top-boundary finalizer.
  const midnightBoundaryKeys = new Set<string>();

  // Authoritative neighbor bounds for every retained record, recomputed
  // from the full final order: the nearest visibly ordered finite
  // predecessor (row date or day midnight) supplies the lower bound, and
  // the nearest finite successor supplies the upper bound expanded through
  // the end of its displayed minute (date + 59_999), with null when no
  // such neighbor exists. Bounds are replaced wholesale each round rather
  // than accumulated monotonically: when an exact timestamp hydrates an
  // earlier date or the day context changes, every neighbor's window
  // follows the current order instead of retaining a stale interval that
  // no longer contains the record.
  const recomputeBounds = (): void => {
    const lowerCandidates = new Map<string, number | null>();
    let lastFinite: number | null = null;
    for (const item of order) {
      if (item.kind === "day") {
        lastFinite = dayMidnightOf(item.day);
        continue;
      }
      const state = retainedByUuid.get(item.uuid);
      if (state === undefined) continue;
      lowerCandidates.set(item.uuid, lastFinite);
      if (state.record.date !== null && Number.isFinite(state.record.date)) {
        lastFinite = state.record.date;
      }
    }
    const upperCandidates = new Map<string, number | null>();
    let nextFinite: number | null = null;
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const item = order[index]!;
      if (item.kind === "day") {
        nextFinite = dayMidnightOf(item.day);
        continue;
      }
      const state = retainedByUuid.get(item.uuid);
      if (state === undefined) continue;
      upperCandidates.set(item.uuid, nextFinite === null ? null : nextFinite + 59_999);
      if (state.record.date !== null && Number.isFinite(state.record.date)) {
        nextFinite = state.record.date;
      }
    }
    for (const [uuid, lower] of lowerCandidates) {
      const state = retainedByUuid.get(uuid);
      if (state === undefined) continue;
      state.bounds.lower = lower;
    }
    for (const [uuid, upper] of upperCandidates) {
      const state = retainedByUuid.get(uuid);
      if (state === undefined) continue;
      state.bounds.upper = upper;
    }
  };

  const recomputeAuthors = (): void => {
    let previousUuid: string | null = null;
    let previousIncomingAuthor: string | null = null;
    for (const item of order) {
      if (item.kind === "day") {
        previousUuid = null;
        previousIncomingAuthor = null;
        continue;
      }
      const state = retainedByUuid.get(item.uuid);
      if (state === undefined) continue;
      if (state.legacy) {
        state.record.author = state.avatarHandleConflicted
          ? null
          : state.avatarHandle ??
            (state.senderLabelConflicted ? null : state.senderLabel);
        delete state.record.viewerAuthored;
        previousUuid = null;
        previousIncomingAuthor = null;
        continue;
      }
      const authorEvidenceConflicted = state.avatarHandleConflicted ||
        (state.avatarHandle === null && state.senderLabelConflicted);
      const ownAuthor = state.avatarHandleConflicted
        ? null
        : state.avatarHandle ??
          (state.senderLabelConflicted ? null : state.senderLabel);
      if (state.sideConflicted) {
        state.record.author = null;
        delete state.record.viewerAuthored;
        previousIncomingAuthor = null;
      } else if (state.side === "incoming") {
        const inherits = !authorEvidenceConflicted &&
          ownAuthor === null &&
          previousUuid !== null &&
          incomingContinuity.has(continuityKeyOf(previousUuid, item.uuid));
        state.record.author = authorEvidenceConflicted
          ? null
          : ownAuthor ?? (inherits ? previousIncomingAuthor : null);
        delete state.record.viewerAuthored;
        previousIncomingAuthor = state.record.author;
      } else if (state.side === "outgoing") {
        state.record.author = "You";
        state.record.viewerAuthored = true;
        previousIncomingAuthor = null;
      } else {
        state.record.author = authorEvidenceConflicted ? null : ownAuthor;
        delete state.record.viewerAuthored;
        previousIncomingAuthor = null;
      }
      previousUuid = item.uuid;
    }
  };

  const extractRound = async (): Promise<XDomChatMessage[]> => {
    const extracted = await extractChatRows(page);
    const continuityUpdates = new Map<string, boolean>();
    // An unretained legacy row is still an observed author boundary. Stage
    // one-sided invalidations as well as the direct previous→next edge so a
    // later overlap cannot carry a stale inferred sender across that row.
    const continuityInvalidationsFrom = new Set<string>();
    const continuityInvalidationsInto = new Set<string>();
    let previousModern: ExtractedChatRow | null = null;
    let brokeSincePreviousModern = false;
    let unretainedBoundarySincePreviousModern = false;
    for (const row of extracted.rows) {
      if (row.kind !== "modern") {
        if (previousModern !== null) brokeSincePreviousModern = true;
        if (stableLegacyChatId(row.platformId) === null) {
          if (previousModern?.platformId !== null && previousModern?.platformId !== undefined) {
            continuityInvalidationsFrom.add(`modern:${previousModern.platformId}`);
          }
          unretainedBoundarySincePreviousModern = true;
        }
        continue;
      }
      if (unretainedBoundarySincePreviousModern && row.platformId !== null) {
        continuityInvalidationsInto.add(`modern:${row.platformId}`);
      }
      if (
        previousModern?.platformId !== null &&
        previousModern?.platformId !== undefined &&
        row.platformId !== null
      ) {
        continuityUpdates.set(
          continuityKeyOf(
            `modern:${previousModern.platformId}`,
            `modern:${row.platformId}`,
          ),
          !brokeSincePreviousModern &&
            row.continuesPreviousUuid === previousModern.platformId,
        );
      }
      previousModern = row;
      brokeSincePreviousModern = false;
      unretainedBoundarySincePreviousModern = false;
    }
    const stagedMidnightBoundaryKeys = new Set<string>();

    // Sticky window headers can render several nested copies of the same
    // rendered day at varying visual tops while same-day rows appear both
    // above and below them. Dedupe the copies by resolved browser-local
    // calendar day, keeping the topmost copy for visual ordering.
    const distinctSeparators = new Map<string, ExtractedChatRound["separators"][number]>();
    for (const separator of extracted.separators) {
      const key = dayKeyOf(separator.day);
      const existing = distinctSeparators.get(key);
      if (
        existing === undefined ||
        separator.top < existing.top ||
        (separator.top === existing.top && separator.order < existing.order)
      ) {
        distinctSeparators.set(key, separator);
      }
    }
    const separators = Array.from(distinctSeparators.values());
    // A round exposing exactly one distinct rendered day normally treats that
    // day as sticky context for every timed modern row in the round,
    // regardless of label top; only genuinely distinct labels behave as
    // visual boundaries. The exception is a real midnight boundary: when the
    // sole label floats between a timed row above and a timed row below
    // whose parsed minutes-of-day strictly decrease across the label
    // (11:59 PM above, 12:00 AM below), the label's visual top is the
    // chronology boundary and rows above it belong to the prior day. Unknown
    // or one-sided evidence keeps the sticky behavior; no day arithmetic is
    // invented for the missing side.
    let stickyDay: ChatLocalDay | null = separators.length === 1 ? separators[0]!.day : null;
    if (stickyDay !== null) {
      const labelTop = separators[0]!.top;
      let aboveTime: { hours: number; minutes: number } | null = null;
      let aboveTop = Number.NEGATIVE_INFINITY;
      let belowTime: { hours: number; minutes: number } | null = null;
      let belowTop = Number.POSITIVE_INFINITY;
      for (const row of extracted.rows) {
        if (row.kind !== "modern" || row.time === null) continue;
        if (row.top < labelTop) {
          if (row.top > aboveTop) {
            aboveTime = row.time;
            aboveTop = row.top;
          }
        } else if (row.top > labelTop) {
          if (row.top < belowTop) {
            belowTime = row.time;
            belowTop = row.top;
          }
        }
      }
      if (aboveTime !== null && belowTime !== null) {
        const minutesOfDay = (time: { hours: number; minutes: number }): number =>
          time.hours * 60 + time.minutes;
        if (minutesOfDay(aboveTime) > minutesOfDay(belowTime)) {
          // The strict minutes descent proves a real midnight boundary:
          // record the evidence so the top-boundary finalizer may later
          // date the rows above it as the immediately previous local day.
          stickyDay = null;
          stagedMidnightBoundaryKeys.add(dayKeyOf(separators[0]!.day));
        }
      }
    }

    const sequence: Array<
      | { kind: "day"; top: number; order: number; day: ChatLocalDay }
      | {
        kind: "row";
        top: number;
        order: number;
        key: string;
        row: ExtractedChatRow;
        legacy: boolean;
      }
      | { kind: "unretainedLegacyRow"; top: number; order: number; row: ExtractedChatRow }
    > = [];
    if (stickyDay === null) {
      for (const separator of separators) {
        sequence.push({ kind: "day", top: separator.top, order: separator.order, day: separator.day });
      }
    }
    for (const row of extracted.rows) {
      const modern = row.kind === "modern";
      const stableLegacyId = modern ? null : stableLegacyChatId(row.platformId);
      sequence.push(modern
        ? {
          kind: "row",
          top: row.top,
          order: row.order,
          key: `modern:${row.platformId}`,
          row,
          legacy: false,
        }
        : stableLegacyId === null
        ? { kind: "unretainedLegacyRow", top: row.top, order: row.order, row }
        : {
          kind: "row",
          top: row.top,
          order: row.order,
          key: `legacy:${stableLegacyId}`,
          row,
          legacy: true,
        });
    }
    sequence.sort((left, right) => left.top - right.top || left.order - right.order);
    if (stickyDay !== null) {
      // The single rendered day is context for the whole round: anchor it
      // above every row of the round in the merged visual order.
      sequence.unshift({ kind: "day", top: Number.NEGATIVE_INFINITY, order: -1, day: stickyDay });
    }

    // Merge the rendered window into the retained visual order using both
    // rows and day separators as anchors. Virtualized DOM may reveal a row
    // that was previously absent between retained anchors ([A, C] followed
    // by [A, B, C]); inserting each new segment at its observed boundary
    // preserves conservative timestamp bounds. A completely disjoint upward
    // window is older and prepends.
    //
    // Unknown day keys are staged with the order mutation. Known separators
    // anchor only where their retained position is compatible with the
    // nearest retained row anchors in this round. This keeps real multi-day
    // boundaries while ignoring a displaced sticky copy such as a retained
    // Today label rendered between rows that already follow it globally.
    const orderIndexByUuid = new Map<string, number>();
    const orderIndexByDayKey = new Map<string, number>();
    order.forEach((item, index) => {
      if (item.kind === "row") {
        orderIndexByUuid.set(item.uuid, index);
      } else {
        orderIndexByDayKey.set(item.key, index);
      }
    });

    type MergeToken = {
      item: ChatOrderItem;
      existingIndex: number | null;
      rowAnchor: boolean;
      dayCandidate: boolean;
    };
    const mergeTokens: MergeToken[] = [];
    const mergeSeenUuids = new Set<string>();
    const stagedDayKeys = new Set<string>();
    for (const item of sequence) {
      if (item.kind === "day") {
        const key = dayKeyOf(item.day);
        if (knownDayKeys.has(key)) {
          const existingIndex = orderIndexByDayKey.get(key);
          if (existingIndex === undefined) {
            throw new Error("X Chat retained day is missing from visual order");
          }
          mergeTokens.push({
            item: { kind: "day", key, day: item.day },
            existingIndex,
            rowAnchor: false,
            dayCandidate: true,
          });
        } else if (!stagedDayKeys.has(key)) {
          stagedDayKeys.add(key);
          mergeTokens.push({
            item: { kind: "day", key, day: item.day },
            existingIndex: null,
            rowAnchor: false,
            dayCandidate: false,
          });
        }
        continue;
      }
      if (item.kind === "unretainedLegacyRow" || mergeSeenUuids.has(item.key)) continue;
      mergeSeenUuids.add(item.key);
      const retained = retainedByUuid.has(item.key);
      const existingIndex = orderIndexByUuid.get(item.key);
      if (retained && existingIndex === undefined) {
        throw new Error("X Chat retained row is missing from visual order");
      }
      if (!retained && existingIndex !== undefined) {
        throw new Error("X Chat visual order contains an unretained row");
      }
      mergeTokens.push({
        item: { kind: "row", uuid: item.key },
        existingIndex: existingIndex ?? null,
        rowAnchor: retained,
        dayCandidate: false,
      });
    }

    // Retained rows are authoritative overlap anchors. Validate them before
    // selecting day anchors so a rejected round cannot mutate either order
    // or the staged key sets.
    let previousRowAnchorIndex = -1;
    for (const token of mergeTokens) {
      if (!token.rowAnchor) continue;
      const anchorIndex = token.existingIndex;
      if (anchorIndex === null || anchorIndex <= previousRowAnchorIndex) {
        throw new Error(
          "X Chat overlap rendered retained rows in contradictory visual order",
        );
      }
      previousRowAnchorIndex = anchorIndex;
    }

    const previousRowIndexes: Array<number | null> = new Array(mergeTokens.length).fill(null);
    let nearestRowIndex: number | null = null;
    mergeTokens.forEach((token, index) => {
      previousRowIndexes[index] = nearestRowIndex;
      if (token.rowAnchor) nearestRowIndex = token.existingIndex;
    });
    const nextRowIndexes: Array<number | null> = new Array(mergeTokens.length).fill(null);
    nearestRowIndex = null;
    for (let index = mergeTokens.length - 1; index >= 0; index -= 1) {
      const token = mergeTokens[index]!;
      nextRowIndexes[index] = nearestRowIndex;
      if (token.rowAnchor) nearestRowIndex = token.existingIndex;
    }

    const selectedAnchorIndexes: Array<number | null> = mergeTokens.map((token, index) => {
      if (token.rowAnchor) return token.existingIndex;
      if (!token.dayCandidate || token.existingIndex === null) return null;
      const previousRowIndex = previousRowIndexes[index];
      const nextRowIndex = nextRowIndexes[index];
      const followsPrevious = previousRowIndex === null || token.existingIndex > previousRowIndex;
      const precedesNext = nextRowIndex === null || token.existingIndex < nextRowIndex;
      return followsPrevious && precedesNext ? token.existingIndex : null;
    });

    let previousAnchorIndex = -1;
    for (const anchorIndex of selectedAnchorIndexes) {
      if (anchorIndex === null) continue;
      if (anchorIndex <= previousAnchorIndex) {
        throw new Error(
          "X Chat overlap rendered retained anchors in contradictory visual order",
        );
      }
      previousAnchorIndex = anchorIndex;
    }

    const insertBeforeIndex = new Map<number, ChatOrderItem[]>();
    let leadingItems: ChatOrderItem[] = [];
    let pendingItems: ChatOrderItem[] = [];
    let firstAnchorIndex: number | null = null;
    let firstAnchorItem: ChatOrderItem | null = null;
    let lastAnchorIndex: number | null = null;
    for (let index = 0; index < mergeTokens.length; index += 1) {
      const token = mergeTokens[index]!;
      const anchorIndex = selectedAnchorIndexes[index]!;
      if (anchorIndex === null) {
        // An existing day that is incompatible with the row anchors is a
        // displaced duplicate, not new content to insert.
        if (token.existingIndex === null) pendingItems.push(token.item);
        continue;
      }
      if (firstAnchorIndex === null) {
        firstAnchorIndex = anchorIndex;
        firstAnchorItem = token.item;
        leadingItems = pendingItems;
      } else if (pendingItems.length > 0) {
        insertBeforeIndex.set(anchorIndex, pendingItems);
      }
      pendingItems = [];
      lastAnchorIndex = anchorIndex;
    }

    let nextOrder: ChatOrderItem[];
    if (firstAnchorIndex === null || lastAnchorIndex === null) {
      nextOrder = [...pendingItems, ...order];
    } else {
      // Leading content belongs before retained day markers immediately
      // above a row anchor unless a matching known sticky day is itself the
      // first anchor. A newly discovered sticky day travels with its leading
      // segment and must precede the retained later-day marker.
      const leadingHasNewDay = leadingItems.some((item) => item.kind === "day");
      let leadingInsertionIndex = firstAnchorIndex;
      while (
        firstAnchorItem?.kind === "row" &&
        (stickyDay === null || leadingHasNewDay) &&
        leadingInsertionIndex > 0 &&
        order[leadingInsertionIndex - 1]!.kind === "day"
      ) {
        leadingInsertionIndex -= 1;
      }
      nextOrder = [];
      order.forEach((item, index) => {
        if (index === leadingInsertionIndex) nextOrder.push(...leadingItems);
        nextOrder.push(...(insertBeforeIndex.get(index) ?? []));
        nextOrder.push(item);
        if (index === lastAnchorIndex) nextOrder.push(...pendingItems);
      });
    }

    order.splice(0, order.length, ...nextOrder);
    for (const key of stagedDayKeys) knownDayKeys.add(key);
    for (const key of stagedMidnightBoundaryKeys) midnightBoundaryKeys.add(key);
    for (const edge of incomingContinuity) {
      const separator = edge.indexOf("\u0000");
      const left = edge.slice(0, separator);
      const right = edge.slice(separator + 1);
      if (
        continuityInvalidationsFrom.has(left) ||
        continuityInvalidationsInto.has(right)
      ) {
        incomingContinuity.delete(edge);
      }
    }
    for (const [key, continuous] of continuityUpdates) {
      if (continuous) incomingContinuity.add(key);
      else incomingContinuity.delete(key);
    }

    // Every undated timed row of this round converts its calendar day
    // inside Chromium below, never in this process's timezone. Sticky-day
    // specs are collected after round assembly below, when every row of
    // the round has its retained state and time-of-day; rows already dated
    // by exact timestamps or earlier rounds never regress.
    const pendingDates = new Map<
      string,
      { year: number; month: number; day: number; hours: number; minutes: number }
    >();

    const round: XDomChatMessage[] = [];
    const seenUuids = new Set<string>();
    for (const item of sequence) {
      if (item.kind === "unretainedLegacyRow") {
        round.push(withChatIdentity({
          platformId: item.row.platformId,
          date: item.row.date,
          text: item.row.text,
          author: item.row.author,
          reactions: item.row.reactions,
        }, null));
        continue;
      }
      if (item.kind === "day") continue;
      if (seenUuids.has(item.key)) continue;
      seenUuids.add(item.key);
      let state = retainedByUuid.get(item.key);
      if (state === undefined) {
        state = {
          record: withChatIdentity({
            platformId: item.row.platformId,
            date: null,
            text: "",
            author: null,
            reactions: [],
          }, item.legacy ? item.key : item.row.platformId),
          time: null,
          exactDate: null,
          avatarHandle: item.legacy ? item.row.author : null,
          avatarHandleConflicted: false,
          senderLabel: null,
          senderLabelConflicted: false,
          side: null,
          sideConflicted: false,
          bounds: { lower: null, upper: null },
          legacy: item.legacy,
        };
        retainedByUuid.set(item.key, state);
      }
      if (state.legacy && item.row.author !== null) {
        if (
          !state.avatarHandleConflicted &&
          state.avatarHandle !== null &&
          state.avatarHandle !== item.row.author
        ) {
          state.avatarHandle = null;
          state.avatarHandleConflicted = true;
        } else if (!state.avatarHandleConflicted) {
          state.avatarHandle = item.row.author;
        }
      }
      if (item.row.date !== null) {
        // Exact rendered timestamps win over separator-derived dates.
        state.exactDate = item.row.date;
        state.record.date = item.row.date;
      }
      if (item.row.text !== "") state.record.text = item.row.text;
      const avatarHandle = item.row.avatarHandle ?? null;
      if (avatarHandle !== null && avatarHandle !== "") {
        if (
          !state.avatarHandleConflicted &&
          state.avatarHandle !== null &&
          state.avatarHandle !== avatarHandle
        ) {
          state.avatarHandle = null;
          state.avatarHandleConflicted = true;
        } else if (!state.avatarHandleConflicted) {
          state.avatarHandle = avatarHandle;
        }
      }
      const senderLabel = item.row.senderLabel ?? null;
      if (senderLabel !== null && senderLabel !== "") {
        if (
          !state.senderLabelConflicted &&
          state.senderLabel !== null &&
          state.senderLabel !== senderLabel
        ) {
          state.senderLabel = null;
          state.senderLabelConflicted = true;
        } else if (!state.senderLabelConflicted) {
          state.senderLabel = senderLabel;
        }
      }
      if (!state.sideConflicted && item.row.side !== null && item.row.side !== undefined) {
        if (state.side !== null && state.side !== item.row.side) {
          state.side = null;
          state.sideConflicted = true;
        } else {
          state.side = item.row.side;
        }
      }
      state.record.reactions = item.row.reactions;
      if (item.row.time !== null) state.time = item.row.time;
      round.push(state.record);
    }

    // The sticky day context dates every timed modern row of the round
    // directly, so new leading rows under an already-known sticky day are
    // dated without relying on a separator being re-inserted before them
    // in the global order. The exact-date guard keeps rendered timestamps
    // and earlier-round dates authoritative.
    if (stickyDay !== null) {
      for (const item of sequence) {
        if (item.kind !== "row" || item.legacy) continue;
        const state = retainedByUuid.get(item.key);
        if (state === undefined || state.record.date !== null || state.time === null) continue;
        pendingDates.set(item.key, {
          year: stickyDay.year,
          month: stickyDay.month,
          day: stickyDay.day,
          hours: state.time.hours,
          minutes: state.time.minutes,
        });
      }
    }

    // Walk the merged visual order once per round: the most recently seen
    // day boundary supplies the calendar spec of every undated timed
    // retained row, so a boundary discovered in a later window backfills
    // records that already scrolled out of the rendering. Rows covered by
    // the round's sticky context are already in the batch. A record is
    // dated only while it has no date at all, so existing finite dates
    // never regress when windows overlap.
    let currentDay: ChatLocalDay | null = null;
    for (const item of order) {
      if (item.kind === "day") {
        currentDay = item.day;
        continue;
      }
      if (item.kind !== "row") continue;
      const state = retainedByUuid.get(item.uuid);
      if (state === undefined || pendingDates.has(item.uuid)) continue;
      if (
        !state.legacy &&
        state.record.date === null &&
        state.time !== null &&
        currentDay !== null
      ) {
        pendingDates.set(item.uuid, {
          year: currentDay.year,
          month: currentDay.month,
          day: currentDay.day,
          hours: state.time.hours,
          minutes: state.time.minutes,
        });
      }
    }

    // One batched conversion per extraction round: Chromium's local
    // constructor turns each {year, month, day, hours, minutes} spec into
    // its epoch inside the page. A non-finite result fails closed — the
    // row keeps its null date instead of receiving NaN.
    if (pendingDates.size > 0) {
      const pending = Array.from(pendingDates.entries());
      const epochs = await page.evaluate(
        (specs) => specs.map(([year, month, day, hours, minutes]) => {
          const value = new Date(year, month, day, hours, minutes).getTime();
          return Number.isFinite(value) ? value : null;
        }),
        pending.map(([, spec]) => [spec.year, spec.month, spec.day, spec.hours, spec.minutes]),
      );
      pending.forEach(([uuid], index) => {
        const epoch = epochs[index];
        if (epoch === null || epoch === undefined) return;
        const state = retainedByUuid.get(uuid);
        // Exact rendered timestamps and earlier-round dates win over
        // separator-derived epochs, matching the pre-existing precedence.
        if (state === undefined || state.record.date !== null) return;
        state.record.date = epoch;
      });
    }

    // With every date resolved, recompute authoritative neighbor bounds for
    // every retained record from the full final order (see recomputeBounds).
    recomputeBounds();
    recomputeAuthors();

    return round;
  };

  const boundsOf = (item: XDomChatMessage): XChatBounds => {
    for (const candidate of retainedByUuid.values()) {
      if (candidate.record === item) {
        return { lower: candidate.bounds.lower, upper: candidate.bounds.upper };
      }
    }
    return { lower: null, upper: null };
  };

  // Fail-closed top-boundary finalizer: when the conversation opens with
  // the previous day's 23:xx group and X renders no label above it, the
  // leading rows stay undated after every round. Called by the collector
  // only after the scroll boundary is proven; it accepts either the
  // earliest retained day item or an earlier finite row whose browser-local
  // day has rendered elsewhere as the calendar anchor. The latter repairs a
  // sticky day item displaced behind a newly prepended finite row. A strict
  // minutes descent into that anchor (or separately recorded midnight
  // evidence), one nondecreasing leading group, and rendered day ownership
  // are all required before assigning the immediately previous local day.
  // Finite and exact dates are never changed.
  const completeTopBoundary = async (): Promise<void> => {
    type TimedTarget = { uuid: string; hours: number; minutes: number };
    type CalendarAnchor =
      | { kind: "day"; index: number; key: string; day: ChatLocalDay }
      | { kind: "row"; index: number; uuid: string; date: number };

    // Legacy rows have no visible time-of-day evidence and therefore never
    // participate in the midnight finalizer. Their conservative neighbor
    // bounds are sufficient for window membership.
    if (!order.some((item) => {
      if (item.kind !== "row") return false;
      const state = retainedByUuid.get(item.uuid);
      return state !== undefined && !state.legacy && state.time !== null;
    })) return;

    // The earliest day item or finite modern row is the first trustworthy
    // calendar anchor. A finite row can precede its sticky day item when a
    // newly discovered overlap batch is prepended ahead of retained context.
    let anchor: CalendarAnchor | null = null;
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index]!;
      if (item.kind === "day") {
        anchor = { kind: "day", index, key: item.key, day: item.day };
        break;
      }
      const state = retainedByUuid.get(item.uuid);
      if (
        state !== undefined &&
        !state.legacy &&
        state.record.date !== null &&
        Number.isFinite(state.record.date)
      ) {
        anchor = { kind: "row", index, uuid: item.uuid, date: state.record.date };
        break;
      }
    }
    if (anchor === null) return;

    let currentDay: ChatLocalDay;
    let currentKey: string;
    const previousTargets: TimedTarget[] = [];
    const currentTargets: TimedTarget[] = [];

    if (anchor.kind === "day") {
      currentDay = anchor.day;
      currentKey = anchor.key;

      // A day-item anchor has only the preceding prior-day group. Its timed
      // minutes must be one nondecreasing sequence.
      let previousMinutes: number | null = null;
      let lastMinutes: number | null = null;
      for (let index = 0; index < anchor.index; index += 1) {
        const item = order[index]!;
        if (item.kind !== "row") continue;
        const state = retainedByUuid.get(item.uuid);
        if (state === undefined || state.legacy || state.time === null) continue;
        const minutes = state.time.hours * 60 + state.time.minutes;
        if (previousMinutes !== null && minutes < previousMinutes) return;
        previousMinutes = minutes;
        lastMinutes = minutes;
        if (state.record.date === null) {
          previousTargets.push({
            uuid: item.uuid,
            hours: state.time.hours,
            minutes: state.time.minutes,
          });
        }
      }
      if (previousTargets.length === 0) return;

      let afterMinutes: number | null = null;
      for (let index = anchor.index + 1; index < order.length; index += 1) {
        const item = order[index]!;
        if (item.kind !== "row") continue;
        const state = retainedByUuid.get(item.uuid);
        if (state === undefined || state.legacy || state.time === null) continue;
        afterMinutes = state.time.hours * 60 + state.time.minutes;
        break;
      }
      if (
        !midnightBoundaryKeys.has(currentKey) &&
        !(
          lastMinutes !== null &&
          afterMinutes !== null &&
          lastMinutes > afterMinutes
        )
      ) {
        return;
      }
    } else {
      // Resolve the finite anchor's calendar day inside Chromium. The Bun
      // process timezone must never decide which rendered day owns a row.
      const localAnchor = await page.evaluate((epoch) => {
        const value = new Date(epoch);
        return {
          year: value.getFullYear(),
          month: value.getMonth(),
          day: value.getDate(),
          hours: value.getHours(),
          minutes: value.getMinutes(),
        };
      }, anchor.date);
      currentKey = `${localAnchor.year}-${localAnchor.month}-${localAnchor.day}`;
      const retainedDayIndex = order.findIndex((item) =>
        item.kind === "day" && item.key === currentKey
      );
      if (retainedDayIndex === -1 || !knownDayKeys.has(currentKey)) return;
      const retainedDay = order[retainedDayIndex]!;
      if (retainedDay.kind !== "day") return;
      currentDay = retainedDay.day;

      // Include the finite anchor as the final timed point. Exactly one
      // strict descent proves one midnight inside the leading prefix:
      // either at the anchor itself (23:55 -> 00:13) or earlier when
      // undated 00:xx rows were prepended before that finite anchor.
      const timed: Array<{ index: number; minutes: number }> = [];
      for (let index = 0; index < anchor.index; index += 1) {
        const item = order[index]!;
        if (item.kind !== "row") continue;
        const state = retainedByUuid.get(item.uuid);
        if (state === undefined || state.legacy || state.time === null) continue;
        timed.push({
          index,
          minutes: state.time.hours * 60 + state.time.minutes,
        });
      }
      timed.push({
        index: anchor.index,
        minutes: localAnchor.hours * 60 + localAnchor.minutes,
      });
      const descentStarts: number[] = [];
      for (let index = 1; index < timed.length; index += 1) {
        if (timed[index]!.minutes < timed[index - 1]!.minutes) {
          descentStarts.push(timed[index]!.index);
        }
      }
      if (descentStarts.length !== 1) return;
      const currentGroupStart = descentStarts[0]!;

      for (let index = 0; index < anchor.index; index += 1) {
        const item = order[index]!;
        if (item.kind !== "row") continue;
        const state = retainedByUuid.get(item.uuid);
        if (
          state === undefined ||
          state.legacy ||
          state.record.date !== null ||
          state.time === null
        ) continue;
        const target = {
          uuid: item.uuid,
          hours: state.time.hours,
          minutes: state.time.minutes,
        };
        (index < currentGroupStart ? previousTargets : currentTargets).push(target);
      }
      if (previousTargets.length === 0) return;

      // Move (never duplicate) the rendered current-day context to the
      // observed midnight split. This repairs neighbor bounds for undated
      // 00:xx rows that were prepended before the finite anchor.
      const currentStartItem = order[currentGroupStart]!;
      if (currentStartItem.kind !== "row") return;
      order.splice(retainedDayIndex, 1);
      const currentStartIndex = order.findIndex((item) =>
        item.kind === "row" && item.uuid === currentStartItem.uuid
      );
      if (currentStartIndex === -1) return;
      order.splice(currentStartIndex, 0, retainedDay);
    }

    // Resolve both sides of the one proven midnight in Chromium. Null-time
    // rich rows stay undated; after the day markers move into calendar
    // order, recomputed finite neighbor bounds decide their membership.
    const resolved = await page.evaluate(
      (
        input: [
          number,
          number,
          number,
          Array<[number, number]>,
          Array<[number, number]>,
        ],
      ) => {
        const [year, month, day, previousSpecs, currentSpecs] = input;
        const previous = new Date(year, month, day - 1);
        const previousDay = {
          year: previous.getFullYear(),
          month: previous.getMonth(),
          day: previous.getDate(),
          midnight: new Date(
            previous.getFullYear(),
            previous.getMonth(),
            previous.getDate(),
          ).getTime(),
        };
        const epochsOf = (
          targetYear: number,
          targetMonth: number,
          targetDay: number,
          specs: Array<[number, number]>,
        ) => specs.map(([hours, minutes]) => {
          const value = new Date(
            targetYear,
            targetMonth,
            targetDay,
            hours,
            minutes,
          ).getTime();
          return Number.isFinite(value) ? value : null;
        });
        return {
          previousDay,
          previousEpochs: epochsOf(
            previousDay.year,
            previousDay.month,
            previousDay.day,
            previousSpecs,
          ),
          currentEpochs: epochsOf(year, month, day, currentSpecs),
        };
      },
      [
        currentDay.year,
        currentDay.month,
        currentDay.day,
        previousTargets.map((target) => [target.hours, target.minutes]),
        currentTargets.map((target) => [target.hours, target.minutes]),
      ] as [
        number,
        number,
        number,
        Array<[number, number]>,
        Array<[number, number]>,
      ],
    );

    const previousKey = dayKeyOf(resolved.previousDay);
    // Put the previous-day context at the start. If a displaced copy already
    // exists, move it rather than violating the one-separator-per-day
    // invariant.
    const existingPreviousIndex = order.findIndex((item) =>
      item.kind === "day" && item.key === previousKey
    );
    if (existingPreviousIndex === -1) {
      knownDayKeys.add(previousKey);
      order.unshift({ kind: "day", key: previousKey, day: resolved.previousDay });
    } else {
      const existingPrevious = order[existingPreviousIndex]!;
      order.splice(existingPreviousIndex, 1);
      order.unshift(existingPrevious);
    }
    previousTargets.forEach((target, index) => {
      const epoch = resolved.previousEpochs[index];
      if (epoch === null || epoch === undefined) return;
      const state = retainedByUuid.get(target.uuid);
      if (state === undefined || state.record.date !== null) return;
      state.record.date = epoch;
    });
    currentTargets.forEach((target, index) => {
      const epoch = resolved.currentEpochs[index];
      if (epoch === null || epoch === undefined) return;
      const state = retainedByUuid.get(target.uuid);
      if (state === undefined || state.record.date !== null) return;
      state.record.date = epoch;
    });
    recomputeBounds();
    recomputeAuthors();
  };

  return Object.assign(extractRound, { boundsOf, completeTopBoundary });
}

export async function extractChatMessages(page: Page): Promise<XDomChatMessage[]> {
  return await createChatMessageExtractor(page)();
}

async function extractChatRows(page: Page): Promise<ExtractedChatRound> {
  const values = await page.locator(X_DOM.chatMessage).evaluateAll((elements, selectors) => {
    interface LocalDay { year: number; month: number; day: number; midnight: number; }
    const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Calendar days resolve to their midnight epoch inside Chromium, so
    // separator bounds never depend on the Bun process timezone.
    const localDayOf = (year: number, month: number, day: number): LocalDay => ({
      year,
      month,
      day,
      midnight: new Date(year, month, day).getTime(),
    });

    const scroller = document.querySelector(selectors.scroller);
    const separatorScope = scroller ?? document.querySelector("main") ?? document.body;

    // X lays out its whole accumulated DM list (~192k px live), so rows and
    // day labels many viewports away still report client rects: layout alone
    // cannot bound a round. When the explicit Chat scroller exists, every
    // candidate row and day label must intersect the scroller viewport
    // expanded by a deterministic 0.5x overscan on each side — exactly one
    // half-viewport advance beyond the viewport. Consecutive half-viewport
    // advances therefore keep a 1.5x-clientHeight overlap (1350px at 900px),
    // so the shared visible rows and the date context immediately around the
    // viewport stay inside consecutive rounds, while rows and labels many
    // viewports away (the newest block under old history) never enter rows,
    // separator dedupe, sticky-day context, or the order merge. The
    // overscan must stay at half a viewport: a 1.5x overscan window (3.6x
    // clientHeight) pre-collects rows up to four advances ahead, so the
    // final moves up a short accumulated list produce four moved no-new
    // rounds and the generic no_progress guard fires before the non-moving
    // top-boundary probe can certify the real top. Without the scroller the
    // legacy main/document behavior is preserved.
    let scrollerWindowTop = Number.NEGATIVE_INFINITY;
    let scrollerWindowBottom = Number.POSITIVE_INFINITY;
    if (scroller instanceof HTMLElement) {
      const scrollerRect = scroller.getBoundingClientRect();
      // Half a viewport per side: the advance step is clientHeight * 0.5,
      // so consecutive extraction windows overlap by 1.5x clientHeight while
      // rows just beyond the prior window (up to one advance above it)
      // surface on the next advance instead of being pre-collected four
      // rounds early and stalling the no-progress guard.
      const overscan = scroller.clientHeight * 0.5;
      scrollerWindowTop = scrollerRect.top - overscan;
      scrollerWindowBottom = scrollerRect.bottom + overscan;
    }

    // Incoming/outgoing geometry resolves against the explicit Chat
    // scroller's (or, without one, the main element's) horizontal center.
    // Rows whose row-owned content gives no defensible side fail closed.
    let contentCenter: number | null = null;
    if (scroller instanceof HTMLElement) {
      const scrollerRect = scroller.getBoundingClientRect();
      contentCenter = scrollerRect.left + scrollerRect.width / 2;
    } else {
      const main = document.querySelector("main");
      if (main instanceof HTMLElement) {
        const mainRect = main.getBoundingClientRect();
        contentCenter = mainRect.left + mainRect.width / 2;
      }
    }

    const separatorDayOf = (value: string): LocalDay | null => {
      const text = collapse(value);
      const lowered = text.toLowerCase();
      if (lowered === "today") {
        return localDayOf(todayMidnight.getFullYear(), todayMidnight.getMonth(), todayMidnight.getDate());
      }
      if (lowered === "yesterday") {
        const day = new Date(todayMidnight);
        day.setDate(day.getDate() - 1);
        return localDayOf(day.getFullYear(), day.getMonth(), day.getDate());
      }
      const weekday = selectors.weekdays[lowered];
      if (weekday !== undefined) {
        let daysBack = (todayMidnight.getDay() - weekday + 7) % 7;
        if (daysBack === 0) daysBack = 7;
        const day = new Date(todayMidnight);
        day.setDate(day.getDate() - daysBack);
        return localDayOf(day.getFullYear(), day.getMonth(), day.getDate());
      }
      const match = selectors.monthDay.exec(text);
      if (match === null) return null;
      const month = selectors.monthIndexByName[match[1]!.toLowerCase()];
      if (month === undefined) return null;
      const dayOfMonth = Number(match[2]);
      if (match[3] !== undefined) {
        return localDayOf(Number(match[3]), month, dayOfMonth);
      }
      let year = todayMidnight.getFullYear();
      let candidate = new Date(year, month, dayOfMonth);
      if (candidate.getTime() > todayMidnight.getTime()) {
        year -= 1;
        candidate = new Date(year, month, dayOfMonth);
      }
      return localDayOf(year, month, dayOfMonth);
    };

    const separators: Array<{ top: number; order: number; day: LocalDay }> = [];
    {
      const scopeElements = Array.from(separatorScope.querySelectorAll("*"));
      for (let index = 0; index < scopeElements.length; index += 1) {
        const element = scopeElements[index];
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom < scrollerWindowTop || rect.top > scrollerWindowBottom) continue;
        if (element.closest(selectors.chatMessage) !== null) continue;
        const text = collapse(element.innerText);
        if (!selectors.dateSeparator.test(text)) continue;
        const day = separatorDayOf(text);
        if (day === null) continue;
        let parent = element.parentElement;
        let innermost = true;
        while (parent !== null && parent !== separatorScope) {
          if (
            parent instanceof HTMLElement &&
            parent.getClientRects().length > 0 &&
            selectors.dateSeparator.test(collapse(parent.innerText))
          ) {
            innermost = false;
            break;
          }
          parent = parent.parentElement;
        }
        if (!innermost) continue;
        separators.push({ top: rect.top, order: index, day });
      }
      separators.sort((left, right) => left.top - right.top || left.order - right.order);
    }

    const visibleTimeOf = (container: HTMLElement): { hours: number; minutes: number } | null => {
      const bodySpans = Array.from(container.querySelectorAll(selectors.bodyText));
      const isBodyTextOrAncestor = (element: HTMLElement): boolean =>
        bodySpans.some((span) => element === span || element.contains(span));
      const candidates: Array<{ top: number; order: number; hours: number; minutes: number }> = [];
      const descendants = Array.from(container.querySelectorAll("*"));
      for (let index = 0; index < descendants.length; index += 1) {
        const element = descendants[index];
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) continue;
        // Only this row's own message-text container is scanned: a nested
        // message-text-OTHER, a link-card preview, or a structured
        // <time datetime> must never supply the row's time-of-day.
        if (element.closest(selectors.body) !== container) continue;
        if (element.closest("a[href], time[datetime]") !== null) continue;
        // The visible time-of-day lives inside the message-text container as
        // a sibling of the body span; only the body span itself and its
        // ancestors are excluded so a message whose body literally reads
        // "10:03 PM" is never mistaken for a timestamp.
        if (isBodyTextOrAncestor(element)) continue;
        const text = collapse(element.innerText);
        const timeMatch = selectors.visibleTime.exec(text);
        if (timeMatch !== null) {
          let hours = Number(timeMatch[1]);
          const minutes = Number(timeMatch[2]);
          if (timeMatch[3]!.toUpperCase() === "PM" && hours < 12) hours += 12;
          if (timeMatch[3]!.toUpperCase() === "AM" && hours === 12) hours = 0;
          candidates.push({ top: element.getBoundingClientRect().top, order: index, hours, minutes });
          continue;
        }
        if (element.tagName === "TIME" && element.getAttribute("datetime") === null) {
          const bareMatch = selectors.bareTime.exec(text);
          if (bareMatch !== null) {
            candidates.push({
              top: element.getBoundingClientRect().top,
              order: index,
              hours: Number(bareMatch[1]),
              minutes: Number(bareMatch[2]),
            });
          }
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((left, right) => left.top - right.top || left.order - right.order);
      const last = candidates[candidates.length - 1]!;
      return { hours: last.hours, minutes: last.minutes };
    };

    const textOf = (element: Element | null) => {
      if (!element) return "";
      const value = element instanceof HTMLElement ? element.innerText : element.textContent;
      return (value ?? "").replace(/\s+/g, " ").trim();
    };
    const parseDate = (entry: Element) => {
      const datetime = entry.querySelector("time[datetime]")?.getAttribute("datetime");
      if (datetime) {
        const parsed = Date.parse(datetime);
        if (Number.isFinite(parsed)) return parsed;
      }
      for (const name of ["data-created-at-ms", "data-timestamp", "data-time", "data-created-at"]) {
        const raw = entry.getAttribute(name) ?? entry.querySelector(`[${name}]`)?.getAttribute(name);
        if (!raw) continue;
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };
    // Modern rows accept only row-owned timestamp attributes: preview
    // datetimes and nested time-like content must never date the row.
    const parseModernRowDate = (entry: Element) => {
      for (const name of ["data-created-at-ms", "data-timestamp", "data-time", "data-created-at"]) {
        const raw = entry.getAttribute(name);
        if (!raw) continue;
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };
    const authorOf = (entry: Element) => {
      for (const attribute of ["data-sender-name", "data-sender-id", "data-author"]) {
        const value = entry.getAttribute(attribute)?.trim();
        if (value) return value;
      }
      const userName = entry.querySelector(selectors.userName);
      if (userName) {
        for (const anchor of userName.querySelectorAll("a[href]")) {
          const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(anchor.getAttribute("href") ?? "");
          if (match) return `@${match[1]}`;
        }
        const value = textOf(userName);
        if (value) return value;
      }
      const label = entry.getAttribute("aria-label") ?? "";
      const labelAuthor = /^(?:message from|from)\s+([^,:]+)/i.exec(label)?.[1]?.trim();
      return labelAuthor || null;
    };
    const platformIdOf = (entry: Element) => {
      for (const attribute of ["data-message-id", "data-event-id", "data-item-id"]) {
        const value = entry.getAttribute(attribute) ?? entry.querySelector(`[${attribute}]`)?.getAttribute(attribute);
        if (value && /^[A-Za-z0-9_-]{1,256}$/.test(value)) return value;
      }
      return null;
    };
    const owningMessageRowOf = (candidate: Element): Element | null => {
      let current: Element | null = candidate;
      while (current !== null) {
        if (current.matches(selectors.row) || current.matches(selectors.messageRowLike)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const reactionsOf = (entry: Element) => {
      const byEmoji = new Map<string, { count: number; reactedByViewer: boolean }>();
      for (const reaction of entry.querySelectorAll(selectors.reaction)) {
        if (!(reaction instanceof HTMLElement) || reaction.getClientRects().length === 0) continue;
        // Reactions belong only to their nearest message row, regardless
        // of whether a nested preview uses the modern or legacy row shape.
        if (owningMessageRowOf(reaction) !== entry) continue;
        const label = reaction.getAttribute("aria-label") ?? "";
        const rawReaction = reaction.getAttribute("data-emoji") ??
          reaction.getAttribute("data-reaction") ?? `${label} ${textOf(reaction)}`;
        const emoji = rawReaction.match(/(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/u)?.[0];
        if (!emoji) continue;
        const countText = `${label} ${textOf(reaction)}`.replace(emoji, " ");
        const rawCount = countText.match(/\b(\d[\d,.]*)\b/)?.[1];
        const count = rawCount ? Number.parseInt(rawCount.replace(/[,.]/g, ""), 10) : 1;
        const previous = byEmoji.get(emoji);
        byEmoji.set(emoji, {
          count: Math.max(previous?.count ?? 0, Number.isFinite(count) ? count : 1),
          reactedByViewer: previous?.reactedByViewer === true || reaction.getAttribute("aria-pressed") === "true",
        });
      }
      return Array.from(byEmoji, ([emoji, value]) => ({ emoji, ...value }));
    };
    // Rich rows (shared posts, image messages, and emoji-only bubbles)
    // render no span[dir="auto"] body. Fall back only to structurally owned
    // evidence: a same-origin /<handle>/status/<numeric-id> anchor
    // (query/hash stripped) yields the canonical shared-post placeholder; an
    // owned image outside a same-origin single-segment profile link yields
    // "[Image]"; and one visible, non-interactive leaf span containing only
    // 1–16 emoji graphemes yields "[Emoji]". Emoji ownership comes from the
    // exact modern row, passive semantics, and geometry inside that row—not
    // font size, which X varies across real message renderings. A candidate
    // counts as owned only when its nearest modern or legacy message row is
    // the current entry itself, it does not sit inside a foreign message-text
    // container, and it is not inside any message-avatar subtree: nested
    // foreign rows, decoy bodies, linked previews, controls, reactions, and
    // avatar artifacts are never used, so unknown rich structures still
    // fail closed with empty text.
    const ownedByEntry = (entry: Element, body: Element | null, candidate: Element): boolean => {
      if (owningMessageRowOf(candidate) !== entry) return false;
      const container = candidate.closest(selectors.body);
      if (container !== null && container !== body) return false;
      if (candidate.closest(selectors.avatar) !== null) return false;
      return true;
    };
    const isPassiveOwnedEvidence = (
      entry: Element,
      body: Element | null,
      candidate: HTMLElement,
    ): boolean => {
      if (!ownedByEntry(entry, body, candidate) || candidate.getClientRects().length === 0) {
        return false;
      }
      const entryRect = entry.getBoundingClientRect();
      const candidateRect = candidate.getBoundingClientRect();
      if (
        candidateRect.width <= 0 ||
        candidateRect.height <= 0 ||
        candidateRect.right <= entryRect.left ||
        candidateRect.left >= entryRect.right ||
        candidateRect.bottom <= entryRect.top ||
        candidateRect.top >= entryRect.bottom
      ) {
        return false;
      }
      if (
        candidate.closest(
          'a, button, [role="button"], input, select, textarea, time[datetime], [contenteditable="true"], [aria-hidden="true"], [hidden]',
        ) !== null ||
        candidate.closest(selectors.reaction) !== null
      ) {
        return false;
      }
      // A passive leaf cannot be certified when it or any wrapper is
      // interactive, hidden, or a reaction surface.
      const foreignBody = candidate.closest(selectors.body);
      if (foreignBody !== null && foreignBody !== body) return false;
      let current: HTMLElement | null = candidate;
      while (current !== null) {
        const currentStyle = getComputedStyle(current);
        if (
          currentStyle.visibility === "hidden" ||
          currentStyle.visibility === "collapse" ||
          Number(currentStyle.opacity) === 0 ||
          current.hidden ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const isVisibleOwnedRichEvidence = (
      entry: Element,
      body: Element | null,
      candidate: HTMLElement,
    ): boolean => {
      if (!ownedByEntry(entry, body, candidate) || candidate.getClientRects().length === 0) {
        return false;
      }
      if (
        candidate.closest(
          'button, [role="button"], input, select, textarea, [contenteditable="true"], [aria-hidden="true"], [hidden]',
        ) !== null ||
        candidate.closest(selectors.reaction) !== null
      ) {
        return false;
      }
      const entryRect = entry.getBoundingClientRect();
      const rect = candidate.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.right <= entryRect.left ||
        rect.left >= entryRect.right ||
        rect.bottom <= entryRect.top ||
        rect.top >= entryRect.bottom
      ) {
        return false;
      }
      let current: HTMLElement | null = candidate;
      while (current !== null) {
        const style = getComputedStyle(current);
        if (
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number(style.opacity) === 0 ||
          current.hidden ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    // Rich rows have no message-text container, but X still renders their
    // clock as a passive row-owned descendant. Accept only an exact visible
    // clock token from this row; links, structured datetimes, reactions,
    // avatars, foreign bodies, and nested message artifacts stay ineligible.
    // This makes a body-less row independently dateable instead of relying
    // on neighbors whose interval may straddle the requested period.
    const rowOwnedVisibleTimeOf = (
      entry: HTMLElement,
      body: Element | null,
    ): { hours: number; minutes: number } | null => {
      const candidates: Array<{ top: number; order: number; hours: number; minutes: number }> = [];
      const descendants = Array.from(entry.querySelectorAll("*"));
      for (let index = 0; index < descendants.length; index += 1) {
        const element = descendants[index];
        if (!(element instanceof HTMLElement)) continue;
        if (!isPassiveOwnedEvidence(entry, body, element)) continue;
        // A passive non-datetime <time> may wrap its clock in presentation
        // spans. Other wrappers stay ineligible so flattened control or card
        // text can never become the row timestamp.
        const passiveTimeWrapper = element.tagName === "TIME" &&
          element.getAttribute("datetime") === null &&
          Array.from(element.querySelectorAll("*")).every((candidate) =>
            candidate instanceof HTMLElement &&
            isPassiveOwnedEvidence(entry, body, candidate)
          );
        if (element.childElementCount !== 0 && !passiveTimeWrapper) continue;
        const text = collapse(element.innerText);
        const timeMatch = selectors.visibleTime.exec(text);
        if (timeMatch !== null) {
          let hours = Number(timeMatch[1]);
          const minutes = Number(timeMatch[2]);
          if (timeMatch[3]!.toUpperCase() === "PM" && hours < 12) hours += 12;
          if (timeMatch[3]!.toUpperCase() === "AM" && hours === 12) hours = 0;
          candidates.push({ top: element.getBoundingClientRect().top, order: index, hours, minutes });
          continue;
        }
        if (element.tagName === "TIME" && element.getAttribute("datetime") === null) {
          const bareMatch = selectors.bareTime.exec(text);
          if (bareMatch !== null) {
            candidates.push({
              top: element.getBoundingClientRect().top,
              order: index,
              hours: Number(bareMatch[1]),
              minutes: Number(bareMatch[2]),
            });
          }
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((left, right) => left.top - right.top || left.order - right.order);
      const last = candidates[candidates.length - 1]!;
      return { hours: last.hours, minutes: last.minutes };
    };
    const passiveEmojiOf = (
      entry: Element,
      body: Element | null,
    ): HTMLElement | null => {
      const entryRect = entry.getBoundingClientRect();
      let match: HTMLElement | null = null;
      for (const candidate of entry.querySelectorAll("span")) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (!isPassiveOwnedEvidence(entry, body, candidate)) continue;
        if (candidate.childElementCount !== 0) continue;
        const rect = candidate.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.right <= entryRect.left ||
          rect.left >= entryRect.right ||
          rect.bottom <= entryRect.top ||
          rect.top >= entryRect.bottom
        ) {
          continue;
        }
        if (!selectors.emojiOnly.test(textOf(candidate))) continue;
        if (candidate.closest("time") !== null) continue;
        // More than one independent passive emoji leaf is ambiguous: it may
        // be decoration around an unsupported control rather than one body.
        if (match !== null) return null;
        match = candidate;
      }
      return match;
    };
    const linkCardAnchorOf = (
      entry: Element,
      body: Element | null,
    ): HTMLElement | null => {
      let match: HTMLElement | null = null;
      for (const anchor of entry.querySelectorAll("a[href]")) {
        if (!(anchor instanceof HTMLElement) || !isVisibleOwnedRichEvidence(entry, body, anchor)) continue;
        const href = anchor.getAttribute("href");
        if (href === null) continue;
        let candidate: URL;
        try {
          candidate = new URL(href, "https://x.com");
        } catch {
          continue;
        }
        if (candidate.protocol !== "http:" && candidate.protocol !== "https:") continue;
        if (candidate.origin === "https://x.com" && selectors.profileLink.test(candidate.pathname)) {
          continue;
        }
        if (candidate.origin === "https://x.com" && selectors.statusAnchor.test(candidate.pathname)) {
          continue;
        }
        const rect = anchor.getBoundingClientRect();
        // X renders a card as a substantial block with multiple visible
        // structural children. Plain navigation/profile anchors and linked
        // emoji leaves stay below this threshold and are not message bodies.
        const visibleChildren = Array.from(anchor.children).filter((child) =>
          child instanceof HTMLElement && child.getClientRects().length > 0
        );
        if (visibleChildren.length === 0 || rect.width < 120 || rect.height < 40) continue;
        if (match !== null) return null;
        match = anchor;
      }
      return match;
    };
    const ownedImageOf = (
      entry: Element,
      body: Element | null,
    ): HTMLElement | null => {
      for (const image of entry.querySelectorAll("img")) {
        if (!(image instanceof HTMLElement) || !isVisibleOwnedRichEvidence(entry, body, image)) continue;
        const anchor = image.closest("a[href]");
        if (anchor === null) return image;
        const href = anchor.getAttribute("href");
        if (href === null) return image;
        try {
          const candidate = new URL(href, "https://x.com");
          if (candidate.origin !== "https://x.com" || !selectors.profileLink.test(candidate.pathname)) {
            return image;
          }
        } catch {
          return image;
        }
      }
      return null;
    };
    const richBodyOf = (entry: Element, body: Element | null): string => {
      for (const anchor of entry.querySelectorAll("a[href]")) {
        if (!(anchor instanceof HTMLElement) || !isVisibleOwnedRichEvidence(entry, body, anchor)) continue;
        const href = anchor.getAttribute("href");
        if (!href) continue;
        try {
          const candidate = new URL(href, "https://x.com");
          if (candidate.origin !== "https://x.com") continue;
          const match = selectors.statusAnchor.exec(candidate.pathname);
          if (match !== null) {
            return `[Shared post] https://x.com/${match[1]}/status/${match[2]}`;
          }
        } catch {
          // Malformed hrefs rendered by extensions never become placeholders.
        }
      }
      if (ownedImageOf(entry, body) !== null) return "[Image]";
      if (passiveEmojiOf(entry, body) !== null) return "[Emoji]";
      if (linkCardAnchorOf(entry, body) !== null) return selectors.linkCardText;
      return "";
    };
    // Rich rows without a body decide their side from the same structurally
    // owned content geometry that yields placeholders: the first owned
    // status anchor, image, or unambiguous passive emoji-only span is the
    // bubble's geometry. Rows with nothing owned stay unknown.
    const richGeometryOf = (entry: Element, body: Element | null): Element | null => {
      for (const anchor of entry.querySelectorAll("a[href]")) {
        if (!(anchor instanceof HTMLElement) || !isVisibleOwnedRichEvidence(entry, body, anchor)) continue;
        const href = anchor.getAttribute("href");
        if (href === null) continue;
        try {
          const candidate = new URL(href, "https://x.com");
          if (candidate.origin !== "https://x.com") continue;
          if (selectors.statusAnchor.test(candidate.pathname)) return anchor;
        } catch {
          // Malformed hrefs never become bubble geometry.
        }
      }
      const image = ownedImageOf(entry, body);
      if (image !== null) return image;
      const emoji = passiveEmojiOf(entry, body);
      if (emoji !== null) return emoji;
      return linkCardAnchorOf(entry, body);
    };
    // Exact avatar handle extraction stays inside this row's avatar
    // subtree: only a same-origin single-segment profile link inside an
    // avatar whose nearest modern message row is this entry becomes a
    // handle. Shared-post previews, foreign nested rows, and arbitrary row
    // profile links never leak authors.
    const avatarHandleOf = (entry: Element): string | null => {
      for (const avatar of entry.querySelectorAll(selectors.avatar)) {
        // Start at the avatar's parent because the avatar itself matches the
        // broad modern-row selector. A nested modern or legacy row between
        // the avatar and this entry keeps the avatar foreign.
        const owner = avatar.parentElement === null
          ? null
          : owningMessageRowOf(avatar.parentElement);
        if (owner !== entry) continue;
        for (const anchor of avatar.querySelectorAll("a[href]")) {
          const href = anchor.getAttribute("href");
          if (href === null) continue;
          try {
            const candidate = new URL(href, "https://x.com");
            if (candidate.origin !== "https://x.com") continue;
            if (selectors.profileLink.test(candidate.pathname)) return `@${candidate.pathname.slice(1)}`;
          } catch {
            // Malformed avatar hrefs never become handles.
          }
        }
      }
      return null;
    };
    // Short sender labels come only from an immediately paired visible
    // sibling: the real modern DOM renders the group-start name in a
    // wrapper that is exactly the row's previousElementSibling, and the
    // synthetic legacy shape carries the label span as the body's
    // previousElementSibling. The pairing evidence is structural, and the
    // candidate must stay small and text-only: time/date labels, message
    // rows, bodies, avatars, reactions, status/media cards, interactive
    // controls, and oversized blocks are never names.
    const senderLabelOf = (entry: Element, body: Element | null): string | null => {
      const candidates = [entry.previousElementSibling];
      if (body instanceof HTMLElement) candidates.push(body.previousElementSibling);
      for (const candidate of candidates) {
        if (!(candidate instanceof HTMLElement) || candidate.getClientRects().length === 0) continue;
        if (
          candidate.matches(selectors.messageRowLike) ||
          (candidate.getAttribute("data-testid") ?? "").startsWith("message-")
        ) {
          continue;
        }
        if (candidate.querySelector(selectors.messageTestId) !== null) continue;
        if (candidate.querySelector(selectors.reaction) !== null) continue;
        if (candidate.querySelector(selectors.labelMedia) !== null) continue;
        if (candidate.querySelector(selectors.labelInteractive) !== null) continue;
        let anchorDecoy = false;
        for (const anchor of candidate.querySelectorAll("a[href]")) {
          const href = anchor.getAttribute("href");
          if (href === null) {
            anchorDecoy = true;
            break;
          }
          try {
            const url = new URL(href, "https://x.com");
            if (url.origin !== "https://x.com" || !selectors.profileLink.test(url.pathname)) {
              anchorDecoy = true;
              break;
            }
          } catch {
            anchorDecoy = true;
            break;
          }
        }
        if (anchorDecoy) continue;
        const style = getComputedStyle(candidate);
        if (
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number(style.opacity) === 0
        ) {
          continue;
        }
        const text = collapse(textOf(candidate)).replace(selectors.bidiControl, "").trim();
        if (text === "") continue;
        if (
          selectors.visibleTime.test(text) ||
          selectors.bareTime.test(text) ||
          selectors.dateSeparator.test(text) ||
          selectors.monthDay.test(text)
        ) {
          continue;
        }
        if (text.length > 50) continue;
        if (candidate.getBoundingClientRect().height > 64) continue;
        return text;
      }
      return null;
    };
    // Incoming/outgoing comes from row-owned body geometry relative to the
    // explicit scroller (or main fallback) center: a body whose whole rect
    // sits left of the center is incoming, one wholly right is outgoing.
    // Bodies spanning the center are not defensible either way and stay
    // unknown, so a long bubble never fabricates an identity.
    const sideOfRow = (entry: Element, body: Element | null): "incoming" | "outgoing" | null => {
      if (contentCenter === null) return null;
      let rect: DOMRect | null = null;
      if (body instanceof HTMLElement && body.getClientRects().length > 0) {
        rect = body.getBoundingClientRect();
      } else {
        const candidate = richGeometryOf(entry, body);
        if (candidate !== null && candidate.getClientRects().length > 0) {
          rect = candidate.getBoundingClientRect();
        }
      }
      if (rect === null) return null;
      if (rect.right <= contentCenter) return "incoming";
      if (rect.left >= contentCenter) return "outgoing";
      return null;
    };

    const modernRowHostOf = (entry: HTMLElement): HTMLElement => {
      let host = entry;
      while (host.parentElement !== null) {
        const siblingRows = Array.from(
          host.parentElement.querySelectorAll(selectors.row),
        ).filter((candidate) =>
          selectors.modernRow.test(candidate.getAttribute("data-testid") ?? "")
        );
        if (siblingRows.length > 1) return host;
        host = host.parentElement;
      }
      return entry;
    };
    const elementByModernUuid = new Map<string, HTMLElement>();

    const positioned = elements.map((entry, order): ExtractedChatRow | null => {
      if (!(entry instanceof HTMLElement) || entry.getClientRects().length === 0) return null;
      // The explicit Chat scroller owns every accepted row: when one
      // exists, the exact scroller element must contain the row, so a
      // sibling conversation, panel, or any other main content outside it
      // never enters the round. Only without a scroller does the legacy
      // main/document fallback apply.
      if (scroller instanceof HTMLElement) {
        if (!scroller.contains(entry)) return null;
      } else if (entry.closest("main") === null) {
        return null;
      }
      const rect = entry.getBoundingClientRect();
      if (rect.bottom < scrollerWindowTop || rect.top > scrollerWindowBottom) return null;
      const testId = entry.getAttribute("data-testid") ?? "";
      const modernMatch = selectors.modernRow.exec(testId);
      const top = rect.top;
      // A row nested inside any modern or legacy row-shaped message
      // artifact is a preview, not an independent message. Only top-level
      // rows in the owning scroller participate in extraction.
      let rowAncestor = entry.parentElement;
      while (rowAncestor !== null) {
        if (rowAncestor.matches(selectors.row) || rowAncestor.matches(selectors.messageRowLike)) {
          return null;
        }
        rowAncestor = rowAncestor.parentElement;
      }
      if (modernMatch === null) {
        // Other message-* test IDs are modern-DOM artifacts (bodies, avatars,
        // actions), never legacy rows.
        if (testId.startsWith("message-")) return null;
        const textCandidates = entry.querySelectorAll(selectors.text);
        let text = "";
        for (const candidate of textCandidates) {
          text = textOf(candidate);
          if (text) break;
        }
        return {
          kind: "legacy",
          platformId: platformIdOf(entry),
          date: parseDate(entry),
          time: null,
          text,
          author: authorOf(entry),
          reactions: reactionsOf(entry),
          top,
          order,
        };
      }
      const uuid = modernMatch[1]!;
      elementByModernUuid.set(uuid, entry);
      // The row is bound to its exact message-text-<UUID> container: a
      // nested message-text-OTHER must never supply body text or a time.
      const body = entry.querySelector(`[data-testid="message-text-${uuid}"]`);
      let text = "";
      if (body instanceof HTMLElement) {
        const spans = Array.from(body.querySelectorAll(selectors.bodyText))
          .filter((span) => span.closest(selectors.body) === body);
        const parts = spans
          .map((span) => textOf(span))
          .filter(Boolean);
        text = parts.join(" ");
      }
      // Without exact body text, rich rows fall back to structural
      // placeholders; unknown rich structures stay empty and fail closed.
      // The bound container (or its absence) defines which message-text
      // elements are foreign inside richBodyOf.
      if (text === "") text = richBodyOf(entry, body);
      return {
        kind: "modern",
        platformId: uuid,
        date: parseModernRowDate(entry),
        time: body instanceof HTMLElement ? visibleTimeOf(body) : rowOwnedVisibleTimeOf(entry, body),
        text,
        // The visible author resolves below, after the round's visual sort,
        // from exact row-owned evidence, sticky incoming labels, and
        // defensible outgoing alignment.
        author: null,
        reactions: reactionsOf(entry),
        top,
        order,
        side: sideOfRow(entry, body),
        senderLabel: senderLabelOf(entry, body),
        avatarHandle: avatarHandleOf(entry),
      };
    });
    const visible = positioned.filter((value): value is ExtractedChatRow => value !== null);
    visible.sort((left, right) => left.top - right.top || left.order - right.order);
    // Incoming continuity requires row hosts that are direct DOM siblings
    // and message rectangles that touch. Filtered or virtualized gaps,
    // legacy rows, date/control wrappers, outgoing rows, and unknown sides
    // therefore fail closed. Exact labels/handles remain row-owned evidence.
    let previousModern: ExtractedChatRow | null = null;
    for (const row of visible) {
      if (row.kind !== "modern") {
        previousModern = null;
        continue;
      }
      row.continuesPreviousUuid = null;
      const ownAuthor = row.avatarHandle ?? row.senderLabel ?? null;
      if (
        ownAuthor === null &&
        row.side === "incoming" &&
        previousModern?.side === "incoming" &&
        previousModern.platformId !== null &&
        row.platformId !== null
      ) {
        const previousEntry = elementByModernUuid.get(previousModern.platformId);
        const entry = elementByModernUuid.get(row.platformId);
        if (previousEntry !== undefined && entry !== undefined) {
          const previousHost = modernRowHostOf(previousEntry);
          const host = modernRowHostOf(entry);
          const gap = entry.getBoundingClientRect().top -
            previousEntry.getBoundingClientRect().bottom;
          if (
            host.previousElementSibling === previousHost &&
            Math.abs(gap) <= 1
          ) {
            row.continuesPreviousUuid = previousModern.platformId;
          }
        }
      }
      if (row.side === "incoming") {
        row.author = ownAuthor ??
          (row.continuesPreviousUuid === previousModern?.platformId
            ? previousModern.author
            : null);
      } else if (row.side === "outgoing") {
        row.author = "You";
      } else {
        row.author = ownAuthor;
      }
      previousModern = row;
    }
    return {
      rows: visible,
      separators: separators.map((separator) => ({
        top: separator.top,
        order: separator.order,
        day: separator.day,
      })),
    };
  }, X_CHAT_EXTRACT_KEYS);
  if (Array.isArray(values)) {
    // Pre-shaped mocked rounds identify modern rows explicitly through the
    // same internal identity key used by production extraction.
    return {
      rows: values.map((value) => ({
        ...(value as ExtractedChatRow),
        kind: (value as XDomChatMessage).identityKey ===
            (value as XDomChatMessage).platformId
          ? "modern" as const
          : "legacy" as const,
        time: null,
        top: 0,
        order: 0,
      })),
      separators: [],
    };
  }
  return values as ExtractedChatRound;
}

export async function extractLinks(page: Page, selector: string): Promise<XDomLink[]> {
  const values = await page.locator(selector).evaluateAll((elements) => {
    return elements.map((element) => {
      const text = element instanceof HTMLElement
        ? element.innerText
        : element.textContent;
      const firstTextLine = (text ?? "")
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .find(Boolean) ?? "";
      const accessibleName = (element.getAttribute("aria-label") ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        href: element.getAttribute("href") ?? "",
        name: firstTextLine || accessibleName,
      };
    });
  });
  return values as XDomLink[];
}

export async function extractPageHeading(page: Page): Promise<string | null> {
  const headings = page.locator(X_DOM.pageHeading);
  const count = Math.min(await headings.count(), 10);
  for (let index = 0; index < count; index += 1) {
    const heading = headings.nth(index);
    if (!(await heading.isVisible())) continue;
    const value = (await heading.innerText()).replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return null;
}

export async function isAuthenticatedMarkerVisible(page: Page): Promise<boolean> {
  return await hasVisible(page, X_DOM.authenticatedAccount) ||
    await hasVisible(page, X_DOM.authenticatedHomeLink) ||
    await hasVisible(page, X_DOM.timelinePost) ||
    await isChatShellVisible(page);
}

export async function isLoginVisible(page: Page): Promise<boolean> {
  if (await hasVisible(page, X_DOM.loginIdentifier) || await hasVisible(page, X_DOM.loginLink)) return true;
  if (await hasAccessibleButton(page, X_ACCESSIBLE_NAMES.login)) return true;
  const text = await extractVisibleControlText(page);
  return X_VISIBLE_TEXT.login.test(text);
}

export async function isChatUnlockVisible(page: Page): Promise<boolean> {
  if (await hasVisible(page, X_DOM.chatUnlockInput)) return true;
  if (await hasAccessibleButton(page, X_ACCESSIBLE_NAMES.chatUnlock)) return true;
  const text = await extractVisibleControlText(page);
  return X_VISIBLE_TEXT.chatUnlock.test(text);
}

export async function isChatShellVisible(page: Page): Promise<boolean> {
  return await hasVisible(page, X_DOM.chatShell) ||
    await hasAccessibleButton(page, X_ACCESSIBLE_NAMES.newChat);
}

async function hasAccessibleButton(page: Page, name: RegExp): Promise<boolean> {
  const buttons = page.getByRole("button", { name });
  const count = Math.min(await buttons.count(), 10);
  for (let index = 0; index < count; index += 1) {
    if (await buttons.nth(index).isVisible()) return true;
  }
  return false;
}

async function hasVisible(page: Page, selector: string): Promise<boolean> {
  const elements = page.locator(selector);
  const count = Math.min(await elements.count(), 20);
  for (let index = 0; index < count; index += 1) {
    if (await elements.nth(index).isVisible()) return true;
  }
  return false;
}

async function extractVisibleControlText(page: Page): Promise<string> {
  const controls = page.locator(X_DOM.controlState);
  const count = Math.min(await controls.count(), 10);
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    values.push((await control.innerText()).replace(/\s+/g, " ").trim());
  }
  return values.join(" ");
}

export async function extractVisibleMainText(page: Page): Promise<string> {
  const main = page.locator(X_DOM.main).first();
  if (!(await main.isVisible())) return "";
  return (await main.innerText()).replace(/\s+/g, " ").trim();
}
