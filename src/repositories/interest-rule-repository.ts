import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { interestRules } from "../db/schema/interest-rule.ts";
import { users } from "../db/schema/user.ts";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
} from "../personalization/personalization.types.ts";
import { NotFoundError } from "../server/errors.ts";

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

async function incrementProfileVersion(database: Database, userId: string): Promise<void> {
  const rows = await database.update(users)
    .set({ interestProfileVersion: sql`${users.interestProfileVersion} + 1`, updatedAt: Date.now() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!rows[0]) throw new NotFoundError("user not found");
}

export async function listActiveInterestRules(
  database: Database,
  userId: string,
  now = Date.now(),
): Promise<PublicInterestRule[]> {
  const rows = await database.select(publicColumns()).from(interestRules).where(and(
    eq(interestRules.userId, userId),
    eq(interestRules.state, "active"),
    or(isNull(interestRules.expiresAt), gt(interestRules.expiresAt, now)),
  )).orderBy(asc(interestRules.kind), asc(interestRules.normalizedLabel), asc(interestRules.id));
  return rows.map(parsePublicRule);
}

export async function saveExplicitInterestRule(
  database: Database,
  input: SaveInterestRuleInput,
): Promise<PublicInterestRule> {
  return await database.transaction(async (transaction) => {
    const tx = transaction as Database;
    const now = Date.now();
    const rows = await tx.insert(interestRules).values({
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
    }).returning(publicColumns());
    await incrementProfileVersion(tx, input.userId);
    return parsePublicRule(rows[0]);
  });
}

export async function updateOwnedInterestRule(
  database: Database,
  id: string,
  userId: string,
  input: UpdateInterestRuleInput,
): Promise<PublicInterestRule> {
  return await database.transaction(async (transaction) => {
    const tx = transaction as Database;
    const rows = await tx.update(interestRules).set({ ...input, updatedAt: Date.now() }).where(and(
      eq(interestRules.id, id), eq(interestRules.userId, userId),
    )).returning(publicColumns());
    if (!rows[0]) throw new NotFoundError("interest rule not found");
    await incrementProfileVersion(tx, userId);
    return parsePublicRule(rows[0]);
  });
}

export async function dismissOwnedInterestRule(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicInterestRule> {
  return await database.transaction(async (transaction) => {
    const tx = transaction as Database;
    const rows = await tx.update(interestRules).set({ state: "dismissed", updatedAt: Date.now() }).where(and(
      eq(interestRules.id, id), eq(interestRules.userId, userId),
    )).returning(publicColumns());
    if (!rows[0]) throw new NotFoundError("interest rule not found");
    await incrementProfileVersion(tx, userId);
    return parsePublicRule(rows[0]);
  });
}
