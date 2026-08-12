import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { digests } from "../db/schema/digest.ts";
import { interestRules, type InterestRuleRow } from "../db/schema/interest-rule.ts";
import {
  storyFeedback,
  type NewStoryFeedbackRow,
  type StoryFeedbackAction,
  type StoryFeedbackRow,
  type StoryFeedbackTargetKind,
} from "../db/schema/story-feedback.ts";
import { digestStories } from "../db/schema/story.ts";
import { users } from "../db/schema/user.ts";
import type { InterestRuleDisposition } from "../personalization/personalization.types.ts";
import { personalizationLabelsSchema } from "../personalization/personalization-label.ts";

/**
 * Extracts unique valid source IDs from a delivered story's persisted sources
 * snapshot. Invalid legacy entries are omitted instead of making the whole
 * story unreadable, mirroring personalizationLabelsSchema semantics.
 */
const storySourceIdsSchema = z.array(z.object({
  sourceId: z.string().uuid(),
})).transform((sources) => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const source of sources) {
    if (seen.has(source.sourceId)) continue;
    seen.add(source.sourceId);
    unique.push(source.sourceId);
  }
  return unique;
});

export interface DeliveredStoryForFeedback {
  digestStoryId: string;
  digestId: string;
  storyId: string;
  storyVersion: number;
  topics: string[];
  entities: string[];
  /** Unique source IDs from the delivered story's persisted sources snapshot. */
  sourceIds: string[];
}

export interface PublicStoryFeedback {
  id: string;
  digestStoryId: string;
  storyId: string;
  storyVersion: number;
  action: StoryFeedbackAction;
  target?: {
    kind: StoryFeedbackTargetKind;
    label: string;
  };
  createdAt: number;
}

export interface SaveStoryFeedbackInput {
  userId: string;
  digestId: string;
  digestStoryId: string;
  storyId: string;
  storyVersion: number;
  action: StoryFeedbackAction;
  targetKind: StoryFeedbackTargetKind | "";
  targetLabel: string;
  createdAt: number;
}

export interface ApplyFeedbackRuleInput {
  userId: string;
  label: string;
  normalizedLabel: string;
  kind: StoryFeedbackTargetKind;
  disposition: InterestRuleDisposition;
  origin: "explicit" | "inferred";
  strength: number;
  now: number;
}

export interface SavedStoryFeedback {
  feedback: PublicStoryFeedback;
  inserted: boolean;
}

function feedbackColumns() {
  return {
    id: storyFeedback.id,
    digestStoryId: storyFeedback.digestStoryId,
    storyId: storyFeedback.storyId,
    storyVersion: storyFeedback.storyVersion,
    action: storyFeedback.action,
    targetKind: storyFeedback.targetKind,
    targetLabel: storyFeedback.targetLabel,
    createdAt: storyFeedback.createdAt,
  };
}

function toPublicFeedback(
  row: Pick<
    StoryFeedbackRow,
    | "id"
    | "digestStoryId"
    | "storyId"
    | "storyVersion"
    | "action"
    | "targetKind"
    | "targetLabel"
    | "createdAt"
  >,
): PublicStoryFeedback {
  return {
    id: row.id,
    digestStoryId: row.digestStoryId,
    storyId: row.storyId,
    storyVersion: row.storyVersion,
    action: row.action,
    ...(row.targetKind === ""
      ? {}
      : { target: { kind: row.targetKind, label: row.targetLabel } }),
    createdAt: row.createdAt,
  };
}

/** Serializes feedback writes for one user so rule upserts and version bumps are atomic. */
export function lockFeedbackUser(
  database: Database,
  userId: string,
): boolean {
  const row = database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row !== undefined;
}

/** Locks and returns a delivered digest-story only when it is owned by the user. */
export function lockOwnedDeliveredStory(
  database: Database,
  userId: string,
  digestStoryId: string,
  storyId: string,
): DeliveredStoryForFeedback | null {
  const row = database
    .select({
      digestStoryId: digestStories.id,
      digestId: digests.id,
      storyId: digestStories.storyId,
      storyVersion: digestStories.storyVersion,
      topics: digestStories.topics,
      entities: digestStories.entities,
      sources: digestStories.sources,
    })
    .from(digestStories)
    .innerJoin(digests, eq(digestStories.digestId, digests.id))
    .where(and(
      eq(digestStories.id, digestStoryId),
      eq(digestStories.storyId, storyId),
      eq(digests.userId, userId),
    ))
    .get();
  if (!row) return null;
  return {
    ...row,
    topics: personalizationLabelsSchema.parse(row.topics),
    entities: personalizationLabelsSchema.parse(row.entities),
    sourceIds: storySourceIdsSchema.parse(row.sources),
  };
}

/** Inserts once for the durable feedback identity and returns the original on retries. */
export function saveStoryFeedbackIdempotently(
  database: Database,
  input: SaveStoryFeedbackInput,
): SavedStoryFeedback {
  const values: NewStoryFeedbackRow = input;
  const inserted = database
    .insert(storyFeedback)
    .values(values)
    .onConflictDoNothing({
      target: [
        storyFeedback.userId,
        storyFeedback.digestId,
        storyFeedback.storyId,
        storyFeedback.storyVersion,
        storyFeedback.action,
        storyFeedback.targetKind,
        storyFeedback.targetLabel,
      ],
    })
    .returning(feedbackColumns())
    .get();
  if (inserted) {
    return { feedback: toPublicFeedback(inserted), inserted: true };
  }

  const existing = database
    .select(feedbackColumns())
    .from(storyFeedback)
    .where(and(
      eq(storyFeedback.userId, input.userId),
      eq(storyFeedback.digestId, input.digestId),
      eq(storyFeedback.storyId, input.storyId),
      eq(storyFeedback.storyVersion, input.storyVersion),
      eq(storyFeedback.action, input.action),
      eq(storyFeedback.targetKind, input.targetKind),
      eq(storyFeedback.targetLabel, input.targetLabel),
    ))
    .get();
  if (!existing) throw new Error("story feedback conflict did not resolve");
  return { feedback: toPublicFeedback(existing), inserted: false };
}

function ruleAlreadyMatches(
  rule: InterestRuleRow,
  input: ApplyFeedbackRuleInput,
): boolean {
  return rule.label === input.label
    && rule.disposition === input.disposition
    && rule.origin === input.origin
    && rule.state === "active"
    && rule.strength === input.strength
    && rule.expiresAt === null;
}

/**
 * Applies a rule without reviving inferred tombstones or overriding explicit rules
 * with inference. Returns true only when persistent rule state actually changed.
 */
export function applyFeedbackInterestRule(
  database: Database,
  input: ApplyFeedbackRuleInput,
): boolean {
  const existing = database
    .select()
    .from(interestRules)
    .where(and(
      eq(interestRules.userId, input.userId),
      eq(interestRules.kind, input.kind),
      eq(interestRules.normalizedLabel, input.normalizedLabel),
    ))
    .get();

  if (input.origin === "inferred" && existing) {
    if (existing.origin === "explicit" || existing.state === "dismissed") return false;
  }
  if (existing && ruleAlreadyMatches(existing, input)) return false;

  if (existing) {
    database
      .update(interestRules)
      .set({
        label: input.label,
        disposition: input.disposition,
        origin: input.origin,
        state: "active",
        strength: input.strength,
        expiresAt: null,
        updatedAt: input.now,
      })
      .where(eq(interestRules.id, existing.id))
      .run();
    return true;
  }

  database.insert(interestRules).values({
    userId: input.userId,
    label: input.label,
    normalizedLabel: input.normalizedLabel,
    kind: input.kind,
    disposition: input.disposition,
    origin: input.origin,
    state: "active",
    strength: input.strength,
    expiresAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  }).run();
  return true;
}
