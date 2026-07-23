import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import type {
  StoryFeedbackAction,
  StoryFeedbackTargetKind,
} from "../db/schema/story-feedback.ts";
import { users } from "../db/schema/user.ts";
import type { InterestRuleDisposition } from "../personalization/personalization.types.ts";
import {
  applyFeedbackInterestRule,
  lockFeedbackUser,
  lockOwnedDeliveredStory,
  saveStoryFeedbackIdempotently,
  type PublicStoryFeedback,
} from "../repositories/story-feedback-repository.ts";
import {
  listActiveInterestRules,
  type PublicInterestRule,
} from "../repositories/interest-rule-repository.ts";
import { NotFoundError, ValidationError } from "../server/errors.ts";
import {
  MAXIMUM_INTEREST_LABEL_LENGTH,
  normalizeInterestLabel,
} from "./interest-service.ts";

const storyActions = [
  "relevant",
  "not_relevant",
  "already_known",
  "too_repetitive",
] as const;
const targetedActions = [
  "follow_topic",
  "show_less_topic",
  "mute_topic",
] as const;

const targetSchema = z.object({
  kind: z.enum(["topic", "entity"]),
  label: z.string().trim().min(1).max(MAXIMUM_INTEREST_LABEL_LENGTH),
}).strict();

const feedbackInputSchema = z.discriminatedUnion("action", [
  z.object({
    userId: z.string().uuid(),
    storyId: z.string().uuid(),
    digestStoryId: z.string().uuid(),
    action: z.enum(storyActions),
    target: z.never().optional(),
  }).strict(),
  z.object({
    userId: z.string().uuid(),
    storyId: z.string().uuid(),
    digestStoryId: z.string().uuid(),
    action: z.enum(targetedActions),
    target: targetSchema,
  }).strict(),
]);

export interface StoryFeedbackTarget {
  kind: StoryFeedbackTargetKind;
  label: string;
}

export interface SubmitStoryFeedbackInput {
  userId: string;
  storyId: string;
  digestStoryId: string;
  action: StoryFeedbackAction;
  target?: StoryFeedbackTarget;
}

export interface SubmitStoryFeedbackResult {
  feedback: PublicStoryFeedback;
  interestRules: PublicInterestRule[];
}

function parseInput(input: SubmitStoryFeedbackInput): SubmitStoryFeedbackInput {
  const result = feedbackInputSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? "invalid story feedback");
  }
  return result.data as SubmitStoryFeedbackInput;
}

function findPersistedTargetLabel(
  labels: string[],
  requestedLabel: string,
): string | null {
  const normalizedRequested = normalizeInterestLabel(requestedLabel);
  return labels.find((label) => normalizeInterestLabel(label) === normalizedRequested) ?? null;
}

function targetedDisposition(action: (typeof targetedActions)[number]): InterestRuleDisposition {
  if (action === "follow_topic") return "prioritize";
  if (action === "show_less_topic") return "show_less";
  return "mute";
}

async function bumpInterestProfileVersion(
  database: Database,
  userId: string,
  now: number,
): Promise<void> {
  await database
    .update(users)
    .set({
      interestProfileVersion: sql`${users.interestProfileVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

export async function submitStoryFeedback(
  database: Database,
  rawInput: SubmitStoryFeedbackInput,
): Promise<SubmitStoryFeedbackResult> {
  const input = parseInput(rawInput);

  return await database.transaction(async (transaction) => {
    const tx = transaction as Database;
    if (!await lockFeedbackUser(tx, input.userId)) {
      throw new NotFoundError("delivered story not found");
    }

    const delivered = await lockOwnedDeliveredStory(
      tx,
      input.userId,
      input.digestStoryId,
      input.storyId,
    );
    if (!delivered) throw new NotFoundError("delivered story not found");

    let targetKind: StoryFeedbackTargetKind | "" = "";
    let targetLabel = "";
    if (input.target) {
      targetKind = input.target.kind;
      const deliveredLabels = targetKind === "topic"
        ? delivered.topics
        : delivered.entities;
      const persistedLabel = findPersistedTargetLabel(deliveredLabels, input.target.label);
      if (!persistedLabel) {
        throw new ValidationError("feedback target is not present in the delivered story");
      }
      targetLabel = persistedLabel;
    }

    const now = Date.now();
    const saved = await saveStoryFeedbackIdempotently(tx, {
      userId: input.userId,
      digestId: delivered.digestId,
      digestStoryId: delivered.digestStoryId,
      storyId: delivered.storyId,
      storyVersion: delivered.storyVersion,
      action: input.action,
      targetKind,
      targetLabel,
      createdAt: now,
    });
    const feedback = saved.feedback;
    let rulesChanged = false;
    if (
      saved.inserted &&
      (input.action === "relevant" || input.action === "not_relevant")
    ) {
      const disposition = input.action === "relevant" ? "prioritize" : "show_less";
      const seen = new Set<string>();
      for (const label of delivered.topics) {
        const normalizedLabel = normalizeInterestLabel(label);
        if (!normalizedLabel || seen.has(normalizedLabel)) continue;
        seen.add(normalizedLabel);
        rulesChanged = await applyFeedbackInterestRule(tx, {
          userId: input.userId,
          label,
          normalizedLabel,
          kind: "topic",
          disposition,
          origin: "inferred",
          strength: 50,
          now,
        }) || rulesChanged;
      }
    } else if (
      saved.inserted &&
      input.target &&
      (
        input.action === "follow_topic" ||
        input.action === "show_less_topic" ||
        input.action === "mute_topic"
      )
    ) {
      rulesChanged = await applyFeedbackInterestRule(tx, {
        userId: input.userId,
        label: targetLabel,
        normalizedLabel: normalizeInterestLabel(targetLabel),
        kind: input.target.kind,
        disposition: targetedDisposition(input.action),
        origin: "explicit",
        strength: 100,
        now,
      });
    }

    if (rulesChanged) await bumpInterestProfileVersion(tx, input.userId, now);

    return {
      feedback,
      interestRules: await listActiveInterestRules(tx, input.userId, now),
    };
  });
}
