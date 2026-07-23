import { and, eq } from "drizzle-orm";
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

export interface DeliveredStoryForFeedback {
  digestStoryId: string;
  digestId: string;
  storyId: string;
  storyVersion: number;
  topics: string[];
  entities: string[];
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
export async function lockFeedbackUser(
  database: Database,
  userId: string,
): Promise<boolean> {
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  return rows.length > 0;
}

/** Locks and returns a delivered digest-story only when it is owned by the user. */
export async function lockOwnedDeliveredStory(
  database: Database,
  userId: string,
  digestStoryId: string,
  storyId: string,
): Promise<DeliveredStoryForFeedback | null> {
  const rows = await database
    .select({
      digestStoryId: digestStories.id,
      digestId: digests.id,
      storyId: digestStories.storyId,
      storyVersion: digestStories.storyVersion,
      topics: digestStories.topics,
      entities: digestStories.entities,
    })
    .from(digestStories)
    .innerJoin(digests, eq(digestStories.digestId, digests.id))
    .where(and(
      eq(digestStories.id, digestStoryId),
      eq(digestStories.storyId, storyId),
      eq(digests.userId, userId),
    ))
    .for("update", { of: digestStories });
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    topics: personalizationLabelsSchema.parse(row.topics),
    entities: personalizationLabelsSchema.parse(row.entities),
  };
}

/** Inserts once for the durable feedback identity and returns the original on retries. */
export async function saveStoryFeedbackIdempotently(
  database: Database,
  input: SaveStoryFeedbackInput,
): Promise<SavedStoryFeedback> {
  const values: NewStoryFeedbackRow = input;
  const inserted = await database
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
    .returning(feedbackColumns());
  if (inserted[0]) {
    return { feedback: toPublicFeedback(inserted[0]), inserted: true };
  }

  const existing = await database
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
    ));
  if (!existing[0]) throw new Error("story feedback conflict did not resolve");
  return { feedback: toPublicFeedback(existing[0]), inserted: false };
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
export async function applyFeedbackInterestRule(
  database: Database,
  input: ApplyFeedbackRuleInput,
): Promise<boolean> {
  const rows = await database
    .select()
    .from(interestRules)
    .where(and(
      eq(interestRules.userId, input.userId),
      eq(interestRules.kind, input.kind),
      eq(interestRules.normalizedLabel, input.normalizedLabel),
    ))
    .for("update");
  const existing = rows[0];

  if (input.origin === "inferred" && existing) {
    if (existing.origin === "explicit" || existing.state === "dismissed") return false;
  }
  if (existing && ruleAlreadyMatches(existing, input)) return false;

  if (existing) {
    await database
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
      .where(eq(interestRules.id, existing.id));
    return true;
  }

  await database.insert(interestRules).values({
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
  });
  return true;
}
