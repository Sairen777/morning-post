import { z } from "zod";
import { createSHA256 } from "hash-wasm";
import type { Database } from "../db/client.ts";
import {
  ConnectorFactory,
  type ConnectorFactoryLike,
} from "../connectors/connector-factory.ts";
import type { NormalizedItem } from "../connectors/connector.types.ts";
import { findSourceById } from "../repositories/source-repository.ts";
import { findFeedById, type PublicFeed } from "../repositories/feed-repository.ts";
import { findUserById, type User } from "../repositories/user-repository.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";
import { composeSummaryRuleset } from "../summarizers/compose-prompt.ts";
import {
  OpenAICompatibleSummarizerService,
  resolveOpenAICompatibleSummarizerModel,
} from "../summarizers/openai-compatible-summarizer.ts";
import type {
  SummarizerService,
  SummaryPoint,
  SummaryRuleset,
} from "../summarizers/summarizer.types.ts";

// --- Types ---

export interface DialogueSample {
  schemaVersion: 1;
  kind: "dialogue-sample";
  capturedAt: number;
  period: { fromMs: number; toMs: number };
  user: { id: string };
  source: { id: string; connectorId: string };
  feed: {
    id: string;
    sourceId: string;
    externalId: string;
    name: string;
    kind: "discussion";
  };
  itemCount: number;
  items: NormalizedItem[];
}

export interface CaptureDialogueSampleInput {
  database: Database;
  userId: string;
  sourceId: string;
  feedId: string;
  fromMs: number;
  toMs: number;
  now?: () => number;
  connectorFactory?: ConnectorFactoryLike;
}

export interface DialogueEvalContext {
  user: User;
  feed: PublicFeed & { kind: "discussion" };
  rules: SummaryRuleset;
  model: string;
  systemPromptHash?: string;
}

export interface SummarizeDialogueSampleInput {
  database: Database;
  sample: DialogueSample;
  userId?: string;
  feedId?: string;
  summarizer?: SummarizerService;
}

export interface DialogueSummarizationResult {
  context: DialogueEvalContext;
  points: SummaryPoint[];
}

export interface HumanGrade {
  score: number;
  comment: string;
}

export interface DialogueEvalRecord {
  schemaVersion: 1;
  kind: "dialogue-eval-record";
  createdAt: number;
  sample: Omit<DialogueSample, "items">;
  model: string;
  systemPrompt: string;
  systemPromptHash: string;
  points: SummaryPoint[];
  score: number;
  comment: string;
}

// --- Zod schemas ---

const dialogueSampleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("dialogue-sample"),
  capturedAt: z.number(),
  period: z.object({
    fromMs: z.number(),
    toMs: z.number(),
  }),
  user: z.object({ id: z.string() }),
  source: z.object({ id: z.string(), connectorId: z.string() }),
  feed: z.object({
    id: z.string(),
    sourceId: z.string(),
    externalId: z.string(),
    name: z.string(),
    kind: z.literal("discussion"),
  }),
  itemCount: z.number(),
  items: z.array(z.unknown()).transform((v) => v as NormalizedItem[]),
});

// --- Parsing helpers ---

export function parseEpochMs(value: string): number {
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && /^\d+$/.test(value)) {
    return asNumber;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`invalid time: ${value}`);
  }
  return timestamp;
}

export function safeSlug(value: string): string {
  const result = value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (result.length === 0) {
    throw new Error("slug is empty");
  }
  return result;
}

export function parseDialogueSample(value: unknown): DialogueSample {
  return dialogueSampleSchema.parse(value);
}

// --- Hashing ---

export async function promptHash(systemPrompt: string): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(new TextEncoder().encode(systemPrompt));
  return hasher.digest("hex") as string;
}

// --- Rendering ---

export function renderSummaryForTerminal(
  result: DialogueSummarizationResult,
): string {
  const { context, points } = result;
  const promptDisplayHash = context.systemPromptHash && context.systemPromptHash.length > 0
    ? context.systemPromptHash
    : "(empty prompt)";

  let output = `Model: ${context.model}\n`;
  output += `Feed: ${context.feed.name}\n`;
  output += `Prompt SHA-256: ${promptDisplayHash}\n\nSummary:\n`;

  if (points.length === 0) {
    output += "(no summary points)";
  } else {
    for (let i = 0; i < points.length; i++) {
      output += `${i + 1}. ${points[i].text}\n`;
    }
  }

  return output;
}

// --- Human grading ---

export function parseHumanScore(value: string): number {
  const trimmed = value.trim();
  const score = Number(trimmed);
  if (
    !Number.isInteger(score) || score < 1 || score > 10 ||
    !/^\d+$/.test(trimmed)
  ) {
    throw new Error("score must be an integer from 1 to 10");
  }
  return score;
}

export function collectHumanGrade(
  readLine: (message: string) => string | null,
): HumanGrade {
  let score: number | undefined;

  while (score === undefined) {
    const input = readLine("Score (1-10): ");
    if (input === null) {
      throw new Error("evaluation cancelled");
    }
    try {
      score = parseHumanScore(input);
    } catch {
      console.error("score must be an integer from 1 to 10");
    }
  }

  const comment = readLine("Comment: ");
  if (comment === null) {
    throw new Error("evaluation cancelled");
  }

  return { score, comment };
}
export async function createDialogueEvalRecord(input: {
  sample: DialogueSample;
  result: DialogueSummarizationResult;
  grade: HumanGrade;
  now?: () => number;
}): Promise<DialogueEvalRecord> {
  const { sample, result, grade } = input;
  const systemPrompt = result.context.rules.systemPrompt;
  const { items: _, ...sampleWithoutItems } = sample;

  return {
    schemaVersion: 1,
    kind: "dialogue-eval-record",
    createdAt: input.now?.() ?? Date.now(),
    sample: sampleWithoutItems,
    model: result.context.model,
    systemPrompt,
    systemPromptHash: await promptHash(systemPrompt),
    points: result.points,
    score: grade.score,
    comment: grade.comment,
  };
}

// --- Markdown rendering ---

function escapeTableCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function renderDialogueEvalMarkdownAppend(
  record: DialogueEvalRecord,
): string {
  const createdAt = new Date(record.createdAt).toISOString();
  const from = new Date(record.sample.period.fromMs).toISOString();
  const to = new Date(record.sample.period.toMs).toISOString();
  const feedName = escapeTableCell(record.sample.feed.name);
  const model = escapeTableCell(record.model);
  const hash = record.systemPromptHash;
  const score = String(record.score);
  const comment = escapeTableCell(record.comment);

  let md =
    `| ${createdAt} | ${feedName} | ${from} \u2013 ${to} | ${model} | sha256:${hash} | ${score} | ${comment} |\n\n`;

  md +=
    `<details id="prompt-${hash}">\n<summary>System prompt sha256:${hash}</summary>\n\n\`\`\`text\n${record.systemPrompt}\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Summary output</summary>\n\n`;
  if (record.points.length === 0) {
    md += `(no summary points)\n`;
  } else {
    for (let i = 0; i < record.points.length; i++) {
      md += `${i + 1}. ${record.points[i].text}\n`;
    }
  }
  md += `</details>\n`;

  return md;
}

const MARKDOWN_HEADER = `# Dialogue summarization evals

| Date | Feed | Period | Used model | Used system prompt | Score | Comment |
| --- | --- | --- | --- | --- | --- | --- |
`;

export async function appendDialogueEvalRecord(
  path: string,
  record: DialogueEvalRecord,
): Promise<void> {
  const parsed = new URL(path, `file://${Deno.cwd()}/`);
  const dir = parsed.pathname.split("/").slice(0, -1).join("/");
  await Deno.mkdir(dir, { recursive: true });

  let exists = false;
  try {
    await Deno.stat(path);
    exists = true;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  if (!exists) {
    await Deno.writeTextFile(path, MARKDOWN_HEADER);
  }

  const fragment = renderDialogueEvalMarkdownAppend(record);
  await Deno.writeTextFile(path, fragment, { append: true });
}

// --- Capture ---

export async function captureDialogueSample(
  input: CaptureDialogueSampleInput,
): Promise<DialogueSample> {
  const {
    database,
    userId,
    sourceId,
    feedId,
    fromMs,
    toMs,
    now,
    connectorFactory,
  } = input;

  const source = await findSourceById(database, sourceId, userId);
  if (source === null) {
    throw new NotFoundError("source not found");
  }

  const feed = await findFeedById(database, feedId, userId);
  if (feed === null) {
    throw new NotFoundError("feed not found");
  }

  if (feed.sourceId !== source.id) {
    throw new ConflictError("feed does not belong to source");
  }

  if (feed.kind !== "discussion") {
    throw new ConflictError("feed must be a discussion");
  }

  const factory = connectorFactory ?? new ConnectorFactory(database);
  const handle = await factory.forSource(source, userId);

  try {
    const normalized = await handle.connector.getNormalizedData(
      fromMs,
      toMs,
      [feed.externalId],
    );
    const items = normalized[feed.externalId] ?? [];

    return {
      schemaVersion: 1,
      kind: "dialogue-sample",
      capturedAt: now?.() ?? Date.now(),
      period: { fromMs, toMs },
      user: { id: userId },
      source: { id: source.id, connectorId: source.connectorId },
      feed: {
        id: feed.id,
        sourceId: feed.sourceId,
        externalId: feed.externalId,
        name: feed.name,
        kind: "discussion",
      },
      itemCount: items.length,
      items,
    };
  } finally {
    await handle.dispose?.();
  }
}

// --- Summarize ---

export async function summarizeDialogueSample(
  input: SummarizeDialogueSampleInput,
): Promise<DialogueSummarizationResult> {
  const { database, sample, summarizer } = input;
  const resolvedUserId = input.userId ?? input.sample.user.id;
  const resolvedFeedId = input.feedId ?? input.sample.feed.id;

  const user = await findUserById(database, resolvedUserId);
  if (user === null) {
    throw new NotFoundError("user not found");
  }

  const feed = await findFeedById(database, resolvedFeedId, resolvedUserId);
  if (feed === null) {
    throw new NotFoundError("feed not found");
  }

  if (feed.kind !== "discussion") {
    throw new ConflictError("feed must be a discussion");
  }

  const rules = composeSummaryRuleset({
    kind: feed.kind,
    systemPrompt: user.systemPrompt,
    customPrompt: feed.customPrompt,
    language: user.defaultLanguage,
  });

  const model = resolveOpenAICompatibleSummarizerModel(user.defaultModel);
  const systemPromptHash = await promptHash(rules.systemPrompt);

  const context: DialogueEvalContext = {
    user,
    feed: feed as PublicFeed & { kind: "discussion" },
    rules,
    model,
    systemPromptHash,
  };

  if (sample.items.length === 0) {
    return { context, points: [] };
  }

  const service = summarizer ?? new OpenAICompatibleSummarizerService();
  const points = await service.summarize(sample.items, rules, {
    model: user.defaultModel ?? undefined,
  });

  return { context, points };
}
