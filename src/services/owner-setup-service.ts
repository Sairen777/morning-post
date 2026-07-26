import { sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "../auth/password.ts";
import type { Database } from "../db/client.ts";
import { users } from "../db/schema/user.ts";
import {
  createUser,
  findOwner,
  type User,
} from "../repositories/user-repository.ts";
import { ConflictError } from "../server/errors.ts";
import { validate } from "../server/validate.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../summarizers/prompts.ts";

export const OWNER_EMAIL = "owner@morning-post.invalid";

export const setupOwnerSchema = z.object({
  name: z.string().trim().min(1, "name must not be empty"),
  password: z.string().min(8, "password must be at least 8 characters"),
}).strict();

export type SetupOwnerInput = z.infer<typeof setupOwnerSchema>;

export async function setupOwner(
  database: Database,
  input: SetupOwnerInput,
): Promise<User> {
  const { name, password } = validate(setupOwnerSchema, input);

  if (await findOwner(database)) {
    throw new ConflictError("owner already exists");
  }

  const passwordHash = await hashPassword(password);

  return await database.transaction(async (transaction) => {
    const tx = transaction as Database;
    await tx.execute(sql`lock table ${users} in share row exclusive mode`);

    if (await findOwner(tx)) {
      throw new ConflictError("owner already exists");
    }

    return await createUser(tx, {
      name,
      email: OWNER_EMAIL,
      passwordHash,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
  });
}
