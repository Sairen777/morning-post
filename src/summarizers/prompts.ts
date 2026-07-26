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

export function buildStoryAnalysisPrompt(): SummaryRuleset {
  return {
    systemPrompt: [
      "Analyze every member of every indexed discussion unit for story and development identity. Units provide bounded thread context only: members of one unit can describe different stories or developments.",
      'Return a JSON array only. Every entry must have exactly these fields: "i" (integer unit index), "m" (integer member index), "topics" (string array), "entities" (string array), "storyKey" (stable concise string), "storyTitle" (string), "developmentKey" (stable concise string), "developmentType" (string), "developmentTitle" (string), and "evidence" (array of at most 3 short verbatim excerpts from that member, each at most 400 UTF-8 bytes).',
      "Include exactly one entry for every submitted (i,m) member pair, with no duplicates, omissions, unknown pairs, or extra fields.",
      "Use surrounding members as discussion context, not as proof that all members share an identity. Use the same storyKey only for members about the same underlying story, and a distinct developmentKey for each stable event or release within it (for example teaser, poster, and trailer are separate developments).",
      "Do not invent URLs or facts. Evidence must be copied from the member's title or text. Keep topics and entities short, deduplicated, and limited to at most 5 each.",
    ].join(" "),
    includeMedia: false,
  };
}

export function buildStoryClassificationPrompt(): SummaryRuleset {
  return {
    systemPrompt: [
      "The first JSON line contains shared activeRules and preferencePrompt context. Every subsequent JSON line is an indexed story to score against that shared context.",
      'Return a JSON array only. Every entry must have exactly these fields: "i" (integer story index), "score" (integer from 0 through 100), "matchedRuleIds" (string array containing only supplied rule IDs), and "reason" (nonempty plain string).',
      "Include exactly one entry for every submitted story index, with no duplicates, omissions, extra indexes, or extra fields.",
      "Scores are absolute relevance scores, not ranks. Do not select a top-K: zero, some, or all stories may qualify independently.",
      "Prioritize rules raise relevance and show_less rules lower it. Mute rules are enforced separately and are not supplied.",
    ].join(" "),
    includeMedia: false,
  };
}

export function buildStoryMediaAnalysisPrompt(): SummaryRuleset {
  return {
    systemPrompt: [
      "Describe the attached media for later story identification.",
      "Report visible facts, readable text, named entities, and the concrete event or release shown.",
      "State uncertainty rather than inventing details.",
      INDEX_INSTRUCTION,
    ].join(" "),
    includeMedia: true,
    showTitle: true,
  };
}

export function buildStorySummaryPrompt(
  options: PromptOptions = {},
): SummaryRuleset {
  return {
    systemPrompt: withTrailingRules([
      "Summarize the supplied source items as one already-selected story.",
      "Do not omit the story or re-evaluate whether the reader wants it.",
      "Consolidate repeated coverage while preserving distinct developments such as a teaser, poster, and trailer.",
      "Lead with what changed and avoid repeating source titles.",
      INDEX_INSTRUCTION,
    ], options),
    showAuthors: false,
    includeMedia: true,
    showTitle: true,
  };
}

export function buildThoroughStorySummaryPrompt(
  options: PromptOptions = {},
): SummaryRuleset {
  return {
    systemPrompt: withTrailingRules([
      "Produce a comprehensive, faithful summary of the supplied source items as one already-selected story.",
      "Do not omit the story, re-evaluate whether the reader wants it, or collapse materially different developments into one.",
      "Preserve every material theme and distinct development, their chronology when the sources establish it, and the important supporting detail needed to understand what happened and why it matters.",
      "Represent disagreements and minority perspectives fairly. Distinguish reported claims from established facts, retain uncertainty and caveats, and state unresolved questions or conflicting accounts instead of inventing a resolution or consensus.",
      "Consolidate genuinely repetitive coverage, but do not erase meaningful differences between sources or stages of the story.",
      "Do not invent facts, motives, implications, causal links, or chronology. Do not pad the summary with generic background, repetition, scene-setting, or trivial detail.",
      INDEX_INSTRUCTION,
    ], options),
    showAuthors: true,
    includeMedia: true,
    showTitle: true,
  };
}

export function buildBatchStorySummaryPrompt(
  options: PromptOptions = {},
): SummaryRuleset {
  return {
    systemPrompt: withTrailingRules([
      "Summarize each supplied, already-selected story independently.",
      'The user message is a JSON array of {"story_id":"opaque ID","sources":[{"i":0,"title":"optional source title","text":"source text"}]} records.',
      'Return a JSON array only, with exactly one object per story: {"story_id":"the exact input ID","points":[{"t":"summary text","i":0}]}.',
      "Return every input story ID exactly once and no unknown IDs. Each points value must be a nonempty array.",
      "Every point index is local to its story. Never use facts or source indexes from another story.",
      "Consolidate repeated coverage while preserving distinct developments. Lead with what changed and avoid repeating source titles.",
    ], options),
    showAuthors: false,
    includeMedia: false,
    showTitle: true,
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
