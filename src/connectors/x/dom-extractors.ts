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
  date: number | null;
  text: string;
  author: string | null;
  reactions: XReaction[];
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

export async function extractChatMessages(page: Page): Promise<XDomChatMessage[]> {
  const values = await page.locator(X_DOM.chatMessage).evaluateAll((elements, selectors) => {
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
    const reactionsOf = (entry: Element) => {
      const byEmoji = new Map<string, { count: number; reactedByViewer: boolean }>();
      for (const reaction of entry.querySelectorAll(selectors.reaction)) {
        if (!(reaction instanceof HTMLElement) || reaction.getClientRects().length === 0) continue;
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

    return elements.map((entry) => {
      const textCandidates = entry.querySelectorAll(selectors.text);
      let text = "";
      for (const candidate of textCandidates) {
        text = textOf(candidate);
        if (text) break;
      }
      return {
        platformId: platformIdOf(entry),
        date: parseDate(entry),
        text,
        author: authorOf(entry),
        reactions: reactionsOf(entry),
      };
    });
  }, {
    text: X_DOM.chatMessageText,
    userName: X_DOM.userName,
    reaction: X_DOM.chatReaction,
  });
  return values as XDomChatMessage[];
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
