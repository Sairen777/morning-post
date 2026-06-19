import { z } from "zod";
import type { Database } from "../db/client.ts";
import { createUser, type User } from "../repositories/user-repository.ts";
import { hashPassword } from "../auth/password.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../summarizers/prompts.ts";
import { validate } from "../server/validate.ts";

export const registerUserSchema = z.object({
  name: z.string().trim().min(1, "name must not be empty"),
  email: z.string().email("email must be a valid address"),
  password: z.string().min(8, "password must be at least 8 characters"),
});

export type RegisterUserInput = z.infer<typeof registerUserSchema>;

export async function registerUser(
  database: Database,
  input: RegisterUserInput,
): Promise<User> {
  const { name, email, password } = validate(registerUserSchema, input);
  const passwordHash = await hashPassword(password);
  return await createUser(database, {
    name,
    email,
    passwordHash,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
}
