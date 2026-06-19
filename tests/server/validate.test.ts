import { assertEquals, assertThrows } from "@std/assert"
import { z } from "zod";
import { validate } from "../../src/server/validate.ts";
import { ValidationError } from "../../src/server/errors.ts";

Deno.test("validate — happy path returns parsed data", () => {
  const schema = z.object({ name: z.string() });
  const result = validate(schema, { name: "test" });
  assertEquals(result, { name: "test" });
});

Deno.test("validate — bad data throws ValidationError with 422", () => {
  const schema = z.object({ name: z.string() });
  let caught: ValidationError | null = null;
  try {
    validate(schema, { name: 123 });
  } catch (error) {
    caught = error as ValidationError;
  }
  assertEquals(caught instanceof ValidationError, true);
  assertEquals(caught!.statusCode, 422);
  assertEquals(caught!.message.includes("Expected string"), true);
});

Deno.test("validate — missing field throws ValidationError", () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  assertThrows(
    () => validate(schema, { name: "test" }),
    ValidationError,
  );
});

Deno.test("validate — multiple errors joined with semicolons", () => {
  const schema = z.object({ name: z.string(), age: z.number() });
  let caught: ValidationError | null = null;
  try {
    validate(schema, { name: 123, age: "not-a-number" });
  } catch (error) {
    caught = error as ValidationError;
  }
  assertEquals(caught instanceof ValidationError, true);
  assertEquals(caught!.statusCode, 422);
  // Messages contain both field error descriptions
  assertEquals(caught!.message.includes("Expected string"), true);
  assertEquals(caught!.message.includes("Expected number"), true);
});

Deno.test("validate — always throws ValidationError, not ZodError", () => {
  const schema = z.object({ name: z.string() });
  assertThrows(
    () => validate(schema, null),
    ValidationError,
  );
});
