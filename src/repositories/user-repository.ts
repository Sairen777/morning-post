import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.ts";
import { users } from "../db/schema/user.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";
import { isUniqueViolation } from "../db/errors.ts";

/**
 * Shape-check applied to every row leaving the repository, so callers can rely
 * on the runtime shape matching the type (catches drift between the migration
 * and the schema definition).
 */
const userRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  passwordHash: z.string().nullable(),
  systemPrompt: z.string(),
  summaryPrompt: z.string(),
  defaultLanguage: z.string().nullable(),
  defaultRelevanceFilterMode: z.enum(["personalized", "include_all"]),
  relevanceThreshold: z.number().int().min(0).max(100),
  maximumStoriesPerDigest: z.number().int().positive().nullable(),
  interestProfileVersion: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type User = z.infer<typeof userRowSchema>;

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string | null;
  systemPrompt: string;
  summaryPrompt?: string;
  defaultLanguage?: string | null;
  defaultRelevanceFilterMode?: "personalized" | "include_all";
  relevanceThreshold?: number;
  maximumStoriesPerDigest?: number | null;
}

export type UpdateUserInput = Partial<{
  name: string;
  systemPrompt: string;
  summaryPrompt: string;
  defaultLanguage: string | null;
  defaultRelevanceFilterMode: "personalized" | "include_all";
  relevanceThreshold: number;
  maximumStoriesPerDigest: number | null;
}>;


function parseUser(row: unknown): User {
  return userRowSchema.parse(row);
}

export function createUser(
  database: Database,
  input: CreateUserInput,
): User {
  const now = Date.now();
  try {
    const rows = database
      .insert(users)
      .values({
        name: input.name,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        systemPrompt: input.systemPrompt,
        summaryPrompt: input.summaryPrompt ?? "",
        defaultLanguage: input.defaultLanguage ?? null,
        defaultRelevanceFilterMode: input.defaultRelevanceFilterMode ?? "personalized",
        relevanceThreshold: input.relevanceThreshold ?? 60,
        maximumStoriesPerDigest: input.maximumStoriesPerDigest ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    return parseUser(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("email already registered");
    }
    throw error;
  }
}

export function findUserById(
  database: Database,
  id: string,
): User | null {
  const rows = database
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();
  return rows[0] ? parseUser(rows[0]) : null;
}

export function findOwner(database: Database): User | null {
  const rows = database
    .select()
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1)
    .all();
  return rows[0] ? parseUser(rows[0]) : null;
}


export function updateUser(
  database: Database,
  id: string,
  partial: UpdateUserInput,
  options: { incrementInterestProfileVersion?: boolean } = {},
): User {
  const updates: Record<string, unknown> = { ...partial, updatedAt: Date.now() };
  if (options.incrementInterestProfileVersion) {
    updates.interestProfileVersion = sql`${users.interestProfileVersion} + 1`;
  }

  const rows = database
    .update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning()
    .all();
  if (!rows[0]) {
    throw new NotFoundError("user not found");
  }
  return parseUser(rows[0]);
}
