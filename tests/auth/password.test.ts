import { assert, assertEquals } from "@std/assert"
import { hashPassword, verifyPassword } from "../../src/auth/password.ts";

Deno.test("verifyPassword is true for the password that was hashed", async () => {
  const password = "correct horse battery staple";
  const encoded = await hashPassword(password);
  assertEquals(await verifyPassword(password, encoded), true);
});

Deno.test("verifyPassword is false for a wrong password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assertEquals(await verifyPassword("Tr0ub4dor&3", encoded), false);
});

Deno.test("hashPassword output is argon2id-encoded and hides the plaintext", async () => {
  const password = "super-secret-passphrase";
  const encoded = await hashPassword(password);
  assert(
    encoded.startsWith("$argon2id$"),
    `expected encoded hash to start with $argon2id$, got: ${encoded}`,
  );
  assert(
    !encoded.includes(password),
    "encoded hash must not contain the plaintext password",
  );
});

Deno.test("hashPassword uses a random salt — same input, different hashes", async () => {
  const password = "same-input";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert(first !== second, "random salt should produce distinct encoded hashes");
  // Both must still verify against the original password.
  assertEquals(await verifyPassword(password, first), true);
  assertEquals(await verifyPassword(password, second), true);
});

Deno.test("verifyPassword returns false for an unparseable hash (does not throw)", async () => {
  assertEquals(await verifyPassword("anything", "not-a-valid-argon2-hash"), false);
});

Deno.test("verifyPassword returns false for an empty hash (does not throw)", async () => {
  assertEquals(await verifyPassword("anything", ""), false);
});
