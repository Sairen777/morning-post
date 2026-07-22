import { test } from "bun:test";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "../assertions.ts";
import {
  type CredentialOwner,
  EnvMasterKeyProvider,
} from "../../src/crypto/key-provider.ts";

const owner: CredentialOwner = {
  userId: "user-a",
  connectorId: "telegram",
};

const otherOwner: CredentialOwner = {
  userId: "user-b",
  connectorId: "telegram",
};

/** Generates a random 32-byte key suitable for use as a master key. */
function generateMasterKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// --- Happy: wrap + unwrap round-trip ---

test("EnvelopeMasterKeyProvider: wrapDataKey then unwrapDataKey round-trips", async () => {
  const masterKey = generateMasterKey();
  const provider = new EnvMasterKeyProvider(masterKey);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await provider.wrapDataKey(dataKey, owner);
  const unwrapped = await provider.unwrapDataKey(wrapped, owner);

  assertEquals(unwrapped, dataKey);
});


test("EnvelopeMasterKeyProvider: owner metadata does not change env wrap behavior", async () => {
  const masterKey = generateMasterKey();
  const provider = new EnvMasterKeyProvider(masterKey);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await provider.wrapDataKey(dataKey, owner);
  const unwrapped = await provider.unwrapDataKey(wrapped, otherOwner);

  assertEquals(unwrapped, dataKey);
});

// --- Scenario: two wraps produce different outputs ---

test("EnvelopeMasterKeyProvider: two wrapDataKey calls produce different wrapped outputs", async () => {
  const masterKey = generateMasterKey();
  const provider = new EnvMasterKeyProvider(masterKey);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped1 = await provider.wrapDataKey(dataKey, owner);
  const wrapped2 = await provider.wrapDataKey(dataKey, owner);

  // Fresh IV per call means wrapped outputs differ even for the same data key.
  assertNotEquals(wrapped1, wrapped2);
});

// --- Edge: tampered wrapped key ---

test("EnvelopeMasterKeyProvider: tampered wrapped key throws", async () => {
  const masterKey = generateMasterKey();
  const provider = new EnvMasterKeyProvider(masterKey);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await provider.wrapDataKey(dataKey, owner);

  // Flip a byte in the ciphertext portion (past the 12-byte IV).
  const tampered = new Uint8Array(wrapped);
  tampered[15] ^= 0x01;

  await assertRejects(
    () => provider.unwrapDataKey(tampered, owner),
    Error,
  );
});

// --- Edge: too-short wrapped key ---

test("EnvelopeMasterKeyProvider: too-short wrapped key throws", async () => {
  const masterKey = generateMasterKey();
  const provider = new EnvMasterKeyProvider(masterKey);

  await assertRejects(
    () => provider.unwrapDataKey(new Uint8Array(10), owner),
    Error,
  );
});

// --- Edge: missing env without constructor arg ---

test("EnvelopeMasterKeyProvider: throws when CREDENTIAL_MASTER_KEY is unset and no arg provided", () => {
  // Only run this test when the env var is genuinely absent.
  // If set in the test runner's environment, skip — we cannot delete it.
  if (process.env["CREDENTIAL_MASTER_KEY"]) {
    return;
  }

  assertThrows(
    () => new EnvMasterKeyProvider(),
    Error,
  );
});

// --- Edge: wrong key ---

test("EnvelopeMasterKeyProvider: unwrapDataKey with wrong master key throws", async () => {
  const masterKeyA = generateMasterKey();
  const masterKeyB = generateMasterKey();
  const providerA = new EnvMasterKeyProvider(masterKeyA);
  const providerB = new EnvMasterKeyProvider(masterKeyB);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await providerA.wrapDataKey(dataKey, owner);

  await assertRejects(
    () => providerB.unwrapDataKey(wrapped, owner),
    Error,
  );
});

// --- Edge: constructor throws for wrong key length ---

test("EnvelopeMasterKeyProvider: throws when key is not 32 bytes", () => {
  assertThrows(
    () => new EnvMasterKeyProvider(new Uint8Array(16)),
    Error,
  );

  assertThrows(
    () => new EnvMasterKeyProvider(new Uint8Array(31)),
    Error,
  );
});

// --- Edge: constructor with empty key array falls through to env ---

test("EnvelopeMasterKeyProvider: empty key array falls through to env check and throws", () => {
  if (process.env["CREDENTIAL_MASTER_KEY"]) {
    return;
  }

  assertThrows(
    () => new EnvMasterKeyProvider(new Uint8Array(0)),
    Error,
  );
});
