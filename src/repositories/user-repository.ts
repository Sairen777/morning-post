import { and, asc, eq, gt, or, sql } from "drizzle-orm";
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
  passwordHash: z.string(),
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
  passwordHash: string;
  systemPrompt: string;
  summaryPrompt?: string;
  defaultLanguage?: string | null;
  defaultRelevanceFilterMode?: "personalized" | "include_all";
  relevanceThreshold?: number;
  maximumStoriesPerDigest?: number | null;
}

export type UpdateUserInput = Partial<{
  name: string;
  email: string;
  passwordHash: string;
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

export async function createUser(
  database: Database,
  input: CreateUserInput,
): Promise<User> {
  const now = Date.now();
  try {
    const rows = await database
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
      .returning();
    return parseUser(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("email already registered");
    }
    throw error;
  }
}

export async function findUserById(
  database: Database,
  id: string,
): Promise<User | null> {
  const rows = await database
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ? parseUser(rows[0]) : null;
}

export async function findUserByEmail(
  database: Database,
  email: string,
): Promise<User | null> {
  const rows = await database
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ? parseUser(rows[0]) : null;
}

export async function listUsers(database: Database): Promise<User[]> {
  const rows = await database
    .select()
    .from(users)
    .orderBy(asc(users.createdAt));
  return rows.map(parseUser);
}

export interface ListUsersPageOptions {
  afterCreatedAt?: number;
  afterId?: string;
  limit: number;
}

export async function listUsersPage(
  database: Database,
  options: ListUsersPageOptions,
): Promise<User[]> {
  const pageLimit = Math.max(1, Math.floor(options.limit));
  const hasCursor = options.afterCreatedAt !== undefined && options.afterId !== undefined;
  if (!hasCursor) {
    const rows = await database
      .select()
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(pageLimit);
    return rows.map(parseUser);
  }

  const rows = await database
    .select()
    .from(users)
    .where(or(
      gt(users.createdAt, options.afterCreatedAt!),
      and(eq(users.createdAt, options.afterCreatedAt!), gt(users.id, options.afterId!)),
    ))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(pageLimit);
  return rows.map(parseUser);
}

export async function updateUser(
  database: Database,
  id: string,
  partial: UpdateUserInput,
  options: { incrementInterestProfileVersion?: boolean } = {},
): Promise<User> {
  const updates: Record<string, unknown> = { ...partial, updatedAt: Date.now() };
  if (options.incrementInterestProfileVersion) {
    updates.interestProfileVersion = sql`${users.interestProfileVersion} + 1`;
  }
  if (partial.email !== undefined) {
    updates.email = partial.email.toLowerCase();
  }

  try {
    const rows = await database
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    if (!rows[0]) {
      throw new NotFoundError("user not found");
    }
    return parseUser(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("email already registered");
    }
    throw error;
  }
}
