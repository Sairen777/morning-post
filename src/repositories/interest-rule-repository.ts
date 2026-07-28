import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { isUniqueViolation } from "../db/errors.ts";
import { interestRules } from "../db/schema/interest-rule.ts";
import { users } from "../db/schema/user.ts";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
} from "../personalization/personalization.types.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";

const publicInterestRuleSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  kind: z.enum(["topic", "entity", "phrase", "story_type"]),
  disposition: z.enum(["prioritize", "show_less", "mute"]),
  origin: z.enum(["explicit", "inferred"]),
  state: z.enum(["active", "dismissed"]),
  strength: z.number().int().min(0).max(100),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type PublicInterestRule = z.infer<typeof publicInterestRuleSchema>;

export interface SaveInterestRuleInput {
  userId: string;
  label: string;
  normalizedLabel: string;
  kind: InterestRuleKind;
  disposition: InterestRuleDisposition;
  strength: number;
  expiresAt?: number | null;
}

export type UpdateInterestRuleInput = Partial<Omit<SaveInterestRuleInput, "userId">>;

function publicColumns() {
  return {
    id: interestRules.id,
    label: interestRules.label,
    kind: interestRules.kind,
    disposition: interestRules.disposition,
    origin: interestRules.origin,
    state: interestRules.state,
    strength: interestRules.strength,
    expiresAt: interestRules.expiresAt,
    createdAt: interestRules.createdAt,
    updatedAt: interestRules.updatedAt,
  };
}

function parsePublicRule(value: unknown): PublicInterestRule {
  return publicInterestRuleSchema.parse(value);
}

function incrementProfileVersion(database: Database, userId: string): void {
  const row = database.update(users)
    .set({ interestProfileVersion: sql`${users.interestProfileVersion} + 1`, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .returning({ id: users.id })
    .get();
  if (!row) throw new NotFoundError("user not found");
}

function lockUserForInterestMutation(
  database: Database,
  userId: string,
): void {
  const row = database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) throw new NotFoundError("user not found");
}

export function listActiveInterestRules(
  database: Database,
  userId: string,
  now = Date.now(),
): PublicInterestRule[] {
  const rows = database.select(publicColumns()).from(interestRules).where(and(
    eq(interestRules.userId, userId),
    eq(interestRules.state, "active"),
    or(isNull(interestRules.expiresAt), gt(interestRules.expiresAt, now)),
  )).orderBy(asc(interestRules.kind), asc(interestRules.normalizedLabel), asc(interestRules.id)).all();
  return rows.map(parsePublicRule);
}

export function saveExplicitInterestRule(
  database: Database,
  input: SaveInterestRuleInput,
): PublicInterestRule {
  return database.transaction((transaction) => {
    const tx = transaction as Database;
    lockUserForInterestMutation(tx, input.userId);
    const now = Date.now();
    const row = tx.insert(interestRules).values({
      ...input,
      origin: "explicit",
      state: "active",
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [interestRules.userId, interestRules.kind, interestRules.normalizedLabel],
      set: {
        label: input.label,
        disposition: input.disposition,
        origin: "explicit",
        state: "active",
        strength: input.strength,
        expiresAt: input.expiresAt ?? null,
        updatedAt: now,
      },
    }).returning(publicColumns()).get();
    incrementProfileVersion(tx, input.userId);
    return parsePublicRule(row);
  }, { behavior: "immediate" });
}

export function updateOwnedInterestRule(
  database: Database,
  id: string,
  userId: string,
  input: UpdateInterestRuleInput,
): PublicInterestRule {
  try {
    return database.transaction((transaction) => {
      const tx = transaction as Database;
      lockUserForInterestMutation(tx, userId);
      const row = tx.update(interestRules).set({
        ...input,
        origin: "explicit",
        updatedAt: Date.now(),
      }).where(and(
        eq(interestRules.id, id), eq(interestRules.userId, userId),
      )).returning(publicColumns()).get();
      if (!row) throw new NotFoundError("interest rule not found");
      incrementProfileVersion(tx, userId);
      return parsePublicRule(row);
    }, { behavior: "immediate" });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("an interest rule with this kind and label already exists");
    }
    throw error;
  }
}

export function dismissOwnedInterestRule(
  database: Database,
  id: string,
  userId: string,
): PublicInterestRule {
  return database.transaction((transaction) => {
    const tx = transaction as Database;
    lockUserForInterestMutation(tx, userId);
    const row = tx.update(interestRules).set({ state: "dismissed", updatedAt: Date.now() }).where(and(
      eq(interestRules.id, id), eq(interestRules.userId, userId),
    )).returning(publicColumns()).get();
    if (!row) throw new NotFoundError("interest rule not found");
    incrementProfileVersion(tx, userId);
    return parsePublicRule(row);
  }, { behavior: "immediate" });
}
