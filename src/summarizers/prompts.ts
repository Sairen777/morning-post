import type {
  FeedKind,
  NormalizedItem,
} from "../connectors/connector.types.ts";
import type { SummaryRuleset } from "./summarizer.types.ts";

export interface PromptOptions {
  language?: string;
  focus?: string;
  maxLength?: number;
}

// Starter summarization prompt assigned to a user at registration. Neutral by
// design — the user edits this to encode their interests and taste. All
// prompt text lives in this module (see AGENTS.md).
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful daily-digest summarizer. Distill each source into the few " +
  "developments that genuinely matter, written plainly and without hype. Skip " +
  "routine noise and lead with what the reader most needs to know.";

const INDEX_INSTRUCTION =
  `Each message starts with [N] where N is its index number. Return a JSON array only — no markdown, no extra text. Each element must have exactly two fields: "t" (the summary bullet as a plain string) and "i" (the integer N of the primary source message). If a bullet covers multiple posts, use the index of the first/primary one.`;

function withTrailingRules(parts: string[], options: PromptOptions): string {
  parts.push(
    options.language
      ? `Write all "t" values in ${options.language}.`
      : `Write all "t" values in the same language as the source messages.`,
  );
  if (options.focus) parts.push(`Focus on: ${options.focus}.`);
  if (options.maxLength) {
    parts.push(`Keep each bullet under ${options.maxLength} characters.`);
  }
  return parts.join(" ");
}

export function buildNewsPrompt(options: PromptOptions = {}): SummaryRuleset {
  const parts = [
    "You are a concise news summarizer.",
    "Messages may contain a [QUOTED_MESSAGE]...[/QUOTED_MESSAGE] block — this is the post being replied to or quoted, providing context for the main message. Use it to better understand the main message but do not summarize the quote separately.",
    INDEX_INSTRUCTION,
  ];
  return {
    systemPrompt: withTrailingRules(parts, options),
    showAuthors: false,
    includeMedia: true,
  };
}

export function buildDiscussionPrompt(
  options: PromptOptions = {},
): SummaryRuleset {
  const parts = [
    "You are a discussion summarizer analyzing a group chat.",
    "Messages may contain a [QUOTED_MESSAGE]...[/QUOTED_MESSAGE] block — this is the message being replied to. Use it for context but do not summarize it separately.",
    "Each message starts with [N] on the first line followed by the author name, then the message text.",
    INDEX_INSTRUCTION,
    "Identify the main topics discussed. For each topic, describe the topic or question, concrete arguments or positions (with author names when relevant), and the conclusion status. If no conclusion was reached, state that the discussion stayed unresolved or had no shared conclusion. Do not produce topic-only bullets that merely describe the subject.",
  ];
  return {
    systemPrompt: withTrailingRules(parts, options),
    showAuthors: true,
    includeMedia: false,
  };
}
export function buildArticlePrompt(
  options: PromptOptions = {},
): SummaryRuleset {
  const parts = [
    "You are a concise article summarizer.",
    "Summarize the supplied nonempty article; never omit it as noise.",
    "The article title is context only. Do not generate or repeat a heading or title in the summary.",
    INDEX_INSTRUCTION,
  ];
  return {
    systemPrompt: withTrailingRules(parts, options),
    showAuthors: false,
    includeMedia: true,
    showTitle: true,
  };
}

export function buildVisionAnalysisPrompt(): SummaryRuleset {
  return {
    systemPrompt: [
      "Analyze the supplied indexed images for a digest summarizer.",
      'Return a JSON array only. Every entry must have exactly two fields: "i" (an integer item index) and "description" (a plain string).',
      "Include exactly one entry for every submitted item index, with no duplicates, omissions, extra indexes, or extra fields.",
      "Describe visible facts and any readable OCR. State uncertainty instead of inventing details.",
      "For albums, preserve input order and label observations as Image 1, Image 2, and so on.",
    ].join(" "),
    includeMedia: true,
  };
}

// Routes items to the appropriate ruleset. When `kind` is provided, it is used
// directly. When omitted, falls back to `meta.isGroup` inference — the legacy
// path for the CLI until feeds are DB-backed.
export function selectRuleset(
  items: NormalizedItem[],
  kind?: FeedKind,
): SummaryRuleset {
  if (kind !== undefined) {
    return kind === "discussion" ? buildDiscussionPrompt() : buildNewsPrompt();
  }
  const isGroup = items[0]?.meta?.isGroup === true;
  return isGroup ? buildDiscussionPrompt() : buildNewsPrompt();
}
