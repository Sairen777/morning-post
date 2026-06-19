import { argon2id, argon2Verify } from "hash-wasm";

/**
 * Argon2id parameters. These follow OWASP's baseline recommendation
 * (memorySize 19 MiB, iterations 2, parallelism 1) and are deliberately
 * conservative for a multi-user VPS. They are constants here but belong in
 * config once a tuning surface exists — bump memory/time cost as hardware
 * allows without breaking existing hashes (the cost is encoded in the hash).
 */
const MEMORY_SIZE_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;

/**
 * Hashes a plaintext password with argon2id, returning the standard encoded
 * `$argon2id$...` string (self-describing: it carries the salt and the cost
 * parameters, so `verifyPassword` needs nothing else).
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  return await argon2id({
    password: plain,
    salt,
    memorySize: MEMORY_SIZE_KIB,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    hashLength: HASH_LENGTH_BYTES,
    outputType: "encoded",
  });
}

/**
 * Verifies a plaintext password against a previously produced encoded hash.
 * Returns false (rather than throwing) on a mismatch or an unparseable hash.
 */
export async function verifyPassword(
  plain: string,
  encoded: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password: plain, hash: encoded });
  } catch {
    return false;
  }
}
