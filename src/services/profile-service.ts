import { z } from "zod";
import type { Database } from "../db/client.ts";
import {
  findUserById,
  type User,
  updateUser,
} from "../repositories/user-repository.ts";
import { NotFoundError, ValidationError } from "../server/errors.ts";
import { validate } from "../server/validate.ts";

export const SYSTEM_PROMPT_MAX_LENGTH = 8 * 1024;

const nullableTrimmedString = z.string().transform((value) => value.trim()).nullable();

const updateProfileSchema = z.object({
  name: z.string().transform((value) => value.trim()).pipe(
    z.string().min(1, "name must not be empty"),
  ).optional(),
  systemPrompt: z.string().max(
    SYSTEM_PROMPT_MAX_LENGTH,
    `systemPrompt must be at most ${SYSTEM_PROMPT_MAX_LENGTH} characters`,
  ).optional(),
  defaultLanguage: nullableTrimmedString.optional(),
  defaultRelevanceFilterMode: z.enum(["personalized", "include_all"]).optional(),
  relevanceThreshold: z.number().int().min(0).max(100).optional(),
  maximumStoriesPerDigest: z.number().int().positive().nullable().optional(),
}).strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

function rejectSensitiveProfileFields(input: unknown): void {
  if (typeof input !== "object" || input === null) {
    return;
  }
  if (Object.hasOwn(input, "email")) {
    throw new ValidationError("email is not mutable through profile settings");
  }
  if (Object.hasOwn(input, "passwordHash")) {
    throw new ValidationError("passwordHash is not mutable through profile settings");
  }
}

export async function getProfile(
  database: Database,
  userId: string,
): Promise<User> {
  const user = await findUserById(database, userId);
  if (!user) {
    throw new NotFoundError("user not found");
  }
  return user;
}

export async function updateProfile(
  database: Database,
  userId: string,
  input: unknown,
): Promise<User> {
  rejectSensitiveProfileFields(input);
  const updates = validate(updateProfileSchema, input);
  const affectsFiltering = updates.defaultRelevanceFilterMode !== undefined ||
    updates.relevanceThreshold !== undefined ||
    updates.maximumStoriesPerDigest !== undefined;
  return await updateUser(database, userId, updates, {
    incrementInterestProfileVersion: affectsFiltering,
  });
}
