import { test } from "bun:test";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "../assertions.ts";
import {
  type CredentialOwner,
  EnvMasterKeyProvider,
} from "../../src/crypto/key-provider.ts";
import {
  CredentialCipher,
  type EncryptedBlob,
} from "../../src/crypto/credential-cipher.ts";

const owner: CredentialOwner = {
  userId: "user-a",
  connectorId: "telegram",
};

const otherOwner: CredentialOwner = {
  userId: "user-b",
  connectorId: "telegram",
};

const otherConnectorOwner: CredentialOwner = {
  userId: "user-a",
  connectorId: "rss",
};

/** Generates a random 32-byte master key and returns a cipher wired with it. */
function generateCipher(): CredentialCipher {
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const provider = new EnvMasterKeyProvider(masterKey);
  return new CredentialCipher(provider);
}

// --- Happy: encrypt then decrypt round-trips ---

test("CredentialCipher: decrypt(encrypt(s)) === s for ASCII", async () => {
  const cipher = generateCipher();
  const plaintext = "Hello, Morning Post!";
  const blob = await cipher.encrypt(plaintext, owner);
  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, plaintext);
});

test("CredentialCipher: decrypt(encrypt(s)) === s for Unicode", async () => {
  const cipher = generateCipher();
  const plaintext = "Привіт 🌍 — こんにちは 🎉";
  const blob = await cipher.encrypt(plaintext, owner);
  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, plaintext);
});

test("CredentialCipher: decrypt(encrypt(s)) === s for emoji-heavy string", async () => {
  const cipher = generateCipher();
  const plaintext = "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘";
  const blob = await cipher.encrypt(plaintext, owner);
  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, plaintext);
});

test("CredentialCipher: realistic Telegram session string round-trips", async () => {
  const cipher = generateCipher();
  // Realistic Telegram session string length (~350 chars of base64-like data).
  const plaintext =
    "1AgAAAABBdXRob3JpemF0aW9uVG9rZW4xMjM0NTY3ODkwYWJjZGVm" +
    "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MGFiY2RlZjAx" +
    "MjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTBhYmNkZWYwMTIz" +
    "NDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwYWJjZGVmMDEyMzQ1" +
    "Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3" +
    "ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTBhYmNkZWYwMTIzNDU2Nzg5" +
    "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwYWJjZGVmMDEyMzQ1Njc4OTAx" +
    "MjM0NTY3ODkwMTIzNDU2Nzg5MGFiY2RlZjAxMjM0NTY3ODkwMTIz" +
    "NDU2Nzg5MDEy";
  const blob = await cipher.encrypt(plaintext, owner);
  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, plaintext);
});

test("CredentialCipher: empty string round-trips", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("", owner);
  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, "");
});

// --- Scenario: fresh keys per encrypt ---

test("CredentialCipher: two encrypt calls produce different iv, ciphertext, and wrappedDataKey", async () => {
  const cipher = generateCipher();
  const plaintext = "same plaintext";

  const blob1 = await cipher.encrypt(plaintext, owner);
  const blob2 = await cipher.encrypt(plaintext, owner);

  assertNotEquals(blob1.iv, blob2.iv);
  assertNotEquals(blob1.ciphertext, blob2.ciphertext);
  assertNotEquals(blob1.wrappedDataKey, blob2.wrappedDataKey);
});

test("CredentialCipher: version field is 1", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("test", owner);
  assertEquals(blob.v, 1);
});

// --- Edge: tampered ciphertext ---

test("CredentialCipher: tampered ciphertext throws on decrypt", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  // Tamper with the ciphertext by flipping a byte in the base64.
  const tampered = tamperBase64(blob.ciphertext);
  const tamperedBlob: EncryptedBlob = { ...blob, ciphertext: tampered };

  await assertRejects(
    () => cipher.decrypt(tamperedBlob, owner),
    Error,
    "tampered",
  );
});

// --- Edge: tampered IV ---

test("CredentialCipher: tampered IV throws on decrypt", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const tampered = tamperBase64(blob.iv);
  const tamperedBlob: EncryptedBlob = { ...blob, iv: tampered };

  await assertRejects(
    () => cipher.decrypt(tamperedBlob, owner),
    Error,
    "tampered",
  );
});

// --- Edge: tampered wrappedDataKey ---

test("CredentialCipher: tampered wrappedDataKey throws on decrypt", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const tampered = tamperBase64(blob.wrappedDataKey);
  const tamperedBlob: EncryptedBlob = { ...blob, wrappedDataKey: tampered };

  await assertRejects(
    () => cipher.decrypt(tamperedBlob, owner),
    Error,
    "tampered",
  );
});

// --- Edge: wrong version ---

test("CredentialCipher: unsupported version throws", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const wrongVersion: EncryptedBlob = { ...blob, v: 999 };

  await assertRejects(
    () => cipher.decrypt(wrongVersion, owner),
    Error,
    "Unsupported EncryptedBlob version",
  );
});

// --- Edge: malformed base64 ---

test("CredentialCipher: malformed base64 in ciphertext throws", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const malformed: EncryptedBlob = { ...blob, ciphertext: "!!!not-base64!!!" };

  await assertRejects(
    () => cipher.decrypt(malformed, owner),
    Error,
    "decode base64",
  );
});

test("CredentialCipher: malformed base64 in iv throws", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const malformed: EncryptedBlob = { ...blob, iv: "!!!not-base64!!!" };

  await assertRejects(
    () => cipher.decrypt(malformed, owner),
    Error,
    "decode base64",
  );
});

test("CredentialCipher: malformed base64 in wrappedDataKey throws", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const malformed: EncryptedBlob = { ...blob, wrappedDataKey: "!!!not-base64!!!" };

  await assertRejects(
    () => cipher.decrypt(malformed, owner),
    Error,
    "decode base64",
  );
});


// --- Edge: decrypt with different owner metadata ---

test("CredentialCipher: decrypt with wrong owner throws", async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt("secret", owner);

  const result = await cipher.decrypt(blob, owner);
  assertEquals(result, "secret");

  await assertRejects(
    () => cipher.decrypt(blob, otherOwner),
    Error,
    "key is wrong",
  );

  await assertRejects(
    () => cipher.decrypt(blob, otherConnectorOwner),
    Error,
    "key is wrong",
  );
});

test("CredentialCipher: unambiguous owner encoding — userId/connectorId pipe collision throws",
async () => {
  const cipher = generateCipher();
  const blob = await cipher.encrypt(
    "secret",
    { userId: "u|telegram", connectorId: "rss" },
  );

  await assertRejects(
    () => cipher.decrypt(blob, { userId: "u", connectorId: "telegram|rss" }),
    Error,
    "key is wrong",
  );
},);

// --- Edge: decrypt with different cipher (different master key) ---

test("CredentialCipher: decrypt with wrong master key throws", async () => {
  const cipherA = generateCipher();
  const cipherB = generateCipher();

  const blob = await cipherA.encrypt("secret", owner);

  await assertRejects(
    () => cipherB.decrypt(blob, owner),
    Error,
    "key is wrong",
  );
});

// --- Helpers ---

/** Flips a byte in a base64-encoded string without breaking base64 validity. */
function tamperBase64(encoded: string): string {
  const bytes = base64ToBytes(encoded);
  // Flip a byte in the middle, but avoid flipping padding-sensitive positions.
  const position = Math.floor(bytes.length / 2);
  bytes[position] ^= 0x01;
  return bytesToBase64(bytes);
}

// Re-implemented here to avoid importing from the module under test
// (these are trivial utility functions).
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
