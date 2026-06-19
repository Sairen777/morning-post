import { z } from "zod";
import { ValidationError } from "./errors.ts";

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return result.data;
}
