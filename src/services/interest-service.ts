import { z } from "zod";
import type { Database } from "../db/client.ts";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
} from "../personalization/personalization.types.ts";
import {
  MAXIMUM_PERSONALIZATION_LABEL_LENGTH,
  personalizationLabelSchema,
} from "../personalization/personalization-label.ts";
import {
  dismissOwnedInterestRule,
  listActiveInterestRules,
  saveExplicitInterestRule,
  updateOwnedInterestRule,
  type PublicInterestRule,
} from "../repositories/interest-rule-repository.ts";

export const MAXIMUM_INTEREST_LABEL_LENGTH =
  MAXIMUM_PERSONALIZATION_LABEL_LENGTH;

const labelSchema = personalizationLabelSchema;
const kindSchema = z.enum(["topic", "entity", "phrase", "story_type"]);
const dispositionSchema = z.enum(["prioritize", "show_less", "mute"]);
const expirySchema = z.number().int().nonnegative().nullable();

const createSchema = z.object({
  userId: z.string().uuid(),
  label: labelSchema,
  kind: kindSchema,
  disposition: dispositionSchema,
  origin: z.literal("explicit").optional(),
  strength: z.number().int().min(0).max(100).default(100),
  expiresAt: expirySchema.optional(),
}).strict();

const updateSchema = z.object({
  label: labelSchema.optional(),
  kind: kindSchema.optional(),
  disposition: dispositionSchema.optional(),
  strength: z.number().int().min(0).max(100).optional(),
  expiresAt: expirySchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one field is required");

export interface CreateInterestRuleInput {
  userId: string;
  label: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  origin?: "explicit";
  strength?: number;
  expiresAt?: number | null;
}

export type UpdateInterestRuleInput = Partial<{
  label: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  strength: number;
  expiresAt: number | null;
}>;

export function normalizeInterestLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export async function listInterests(database: Database, userId: string): Promise<PublicInterestRule[]> {
  return await listActiveInterestRules(database, z.string().uuid().parse(userId));
}

export async function createInterest(
  database: Database,
  input: CreateInterestRuleInput,
): Promise<PublicInterestRule> {
  const parsed = createSchema.parse(input);
  return await saveExplicitInterestRule(database, {
    ...parsed,
    normalizedLabel: normalizeInterestLabel(parsed.label),
  });
}

export async function updateInterest(
  database: Database,
  id: string,
  userId: string,
  input: UpdateInterestRuleInput,
): Promise<PublicInterestRule> {
  const parsed = updateSchema.parse(input);
  const labelFields = parsed.label === undefined ? {} : {
    label: parsed.label,
    normalizedLabel: normalizeInterestLabel(parsed.label),
  };
  return await updateOwnedInterestRule(database, z.string().uuid().parse(id), z.string().uuid().parse(userId), {
    ...parsed,
    ...labelFields,
  });
}

export async function dismissInterest(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicInterestRule> {
  return await dismissOwnedInterestRule(
    database,
    z.string().uuid().parse(id),
    z.string().uuid().parse(userId),
  );
}
