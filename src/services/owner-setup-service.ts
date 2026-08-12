import { z } from "zod";
import type { Database } from "../db/client.ts";
import {
  createUser,
  findOwner,
  type User,
} from "../repositories/user-repository.ts";
import { ConflictError } from "../server/errors.ts";
import { validate } from "../server/validate.ts";

export const OWNER_EMAIL = "owner@morning-post.invalid";

export const setupOwnerSchema = z.object({
  name: z.string().trim().min(1, "name must not be empty"),
}).strict();

export type SetupOwnerInput = z.infer<typeof setupOwnerSchema>;

export async function setupOwner(
  database: Database,
  input: SetupOwnerInput,
): Promise<User> {
  const { name } = validate(setupOwnerSchema, input);

  if (await findOwner(database)) {
    throw new ConflictError("owner already exists");
  }

  return database.transaction((transaction) => {
    const tx = transaction as Database;

    if (findOwner(tx)) {
      throw new ConflictError("owner already exists");
    }

    return createUser(tx, {
      name,
      email: OWNER_EMAIL,
      passwordHash: null,
      // Empty interest prompt: no preference signal until the user writes one.
      systemPrompt: "",
    });
  }, { behavior: "immediate" });
}
