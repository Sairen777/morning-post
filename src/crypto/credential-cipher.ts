import type { CredentialOwner, KeyProvider } from "./key-provider.ts";
function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    (value.includes("=") && !/=+$/.test(value))
  ) {
    throw new TypeError("Invalid base64");
  }
  return Buffer.from(value, "base64");
}

const textEncoder = new TextEncoder();

/**
 * Serialized envelope-encrypted credential.
 *
 * `v` is the scheme version. Bump it when the encryption format changes so old
 * blobs can be detected and re-wrapped during key rotation without guessing.
 */
export interface EncryptedBlob {
  /** Scheme version — bump on format change; enables key rotation detection. */
  v: number;
  /** Base64-encoded wrapped data key (per-call fresh key, encrypted by KeyProvider). */
  wrappedDataKey: string;
  /** Base64-encoded 96-bit initialization vector used for the data encryption. */
  iv: string;
  /** Base64-encoded AES-256-GCM ciphertext with the 16-byte authentication tag appended. */
  ciphertext: string;
}

/**
 * Encrypts and decrypts credential plaintexts using envelope encryption.
 *
 * Each `encrypt` call:
 * 1. Generates a fresh random 256-bit data key.
 * 2. Encrypts the plaintext under that data key with AES-256-GCM (fresh IV),
 *    bound to the credential owner as additional authenticated data.
 * 3. Wraps the data key via the configured `KeyProvider`.
 * 4. Returns all pieces base64-encoded in an `EncryptedBlob`.
 *
 * The `KeyProvider` is the extension point: swap `EnvMasterKeyProvider` for a
 * KMS-backed provider and no cipher code changes.
 *
 * ---
 *
 * ## Strengthening roadmap
 *
 * This is not a TODO list — it is an architectural note on what each hardening
 * layer achieves, when it matters, and what the migration looks like.
 *
 * ### 1. Move the master key into a managed KMS
 *
 * The `KeyProvider` interface is the seam. Swap `EnvMasterKeyProvider` for a
 * `KmsKeyProvider` that calls AWS KMS `encrypt`/`decrypt`, GCP KMS, or Vault
 * Transit, and the master key never enters this process. Benefits:
 *
 * - **Revocation kill-switch**: disable the KMS key and all stored credentials
 *   are instantly dead — no DB cleanup needed.
 * - **Removes key from backup blast radius**: DB backups / snapshots contain only
 *   wrapped data keys; the master key lives in the KMS, not on disk.
 * - **Access audit**: KMS logs every encrypt/decrypt call (who, when, what key).
 *
 * Migration: implement `KmsKeyProvider implements KeyProvider`, swap one
 * constructor argument. No stored blobs change — the same wrapped data keys work.
 *
 * ### 2. Owner binding through AEAD additional authenticated data (AAD)
 *
 * Ciphertexts are already bound to `userId | connectorId` so a blob cannot be
 * transplanted between rows or users. Without this mandatory AAD, an attacker
 * who can write to the DB (but not read the key) could move a credential
 * between accounts.
 *
 * WebCrypto's `encrypt` receives `additionalData` here and on `decrypt`.
 * The `EncryptedBlob` format does not change; the owner is supplied at
 * encrypt/decrypt time by the caller (the persistence layer knows which
 * user/connector it serves). A KMS-backed `KeyProvider` should mirror the same
 * owner binding in its encryption context / labels.
 *
 * ### 3. Key rotation
 *
 * Master-key rotation re-encrypts every stored wrapped data key under a new
 * master key. It does NOT change the `v` field — that version identifies the
 * cipher envelope format, not which master key was used.
 *
 * A rotation procedure with the single-version constraint:
 *
 * 1. Generate a new master key, but keep the old one available (both as live
 *    `KeyProvider` instances — old root for unwrap, new root for wrap).
 * 2. For each stored `EncryptedBlob` whose `v` matches the current version (1):
 *    - Unwrap the data key via the old `KeyProvider`.
 *    - Re-wrap the same data key via the new `KeyProvider`.
 *    - Write back the blob with `v` unchanged (still 1).
 * 3. The plaintext is never decrypted — only data keys are re-wrapped, so this
 *    is safe to run online with no downtime.
 *
 * **Caveat — missing key identifier**: The current `EncryptedBlob` format has
 * no master-key identifier (`kid`). During rotation, you cannot tell which
 * master key wraps a given row without trying both (or bookkeeping a separate
 * list of processed rows). A transition period where both keys are tried
 * (attempt old, fall back to new) is required until all rows are migrated.
 * Alternatively, add an optional `kid` field to `EncryptedBlob` to make future
 * rotations unambiguous — the unwrap path then selects the right
 * `KeyProvider` by `kid`; omitting `kid` (or a sentinel value) selects the
 * canonical key.
 *
 * ### 4. Encrypted backups
 *
 * Database backups must be encrypted with a **separate** key, never the same
 * master key used for credentials. Backups contain encrypted ciphertexts already,
 * but they also contain metadata (user emails, feed names) that should not be
 * plaintext in off-site storage.
 *
 * ### 5. Per-user KMS keys
 *
 * The strongest multi-user posture: each user gets a dedicated KMS key, not just
 * a per-user data key wrapped by one master. The `KeyProvider` then dispatches
 * per `userId` — a single KMS key compromise affects one user, not all.
 *
 * Migration: create a `MultiTenantKeyProvider` that selects the KMS key from
 * the mandatory `owner.userId` metadata already passed through this seam.
 *
 * ### 6. Honest residual
 *
 * A live rooted host can still use the key in-process while the service is up.
 * KMS cannot stop this — a root compromise that lets the attacker read process
 * memory or inject code can decrypt credentials until the compromise is detected
 * and terminated. This is irreducible for a scheduled service that must decrypt
 * without the user present (see ARCHITECTURE.md "Credentials & secrets").
 *
 * The goal is not "even we can't read it" — the server must read it at 6am to
 * build the digest. The goal is: a DB/backup leak alone exposes nothing, access
 * can be revoked instantly, and blast radius is one user, not everyone.
 */
export class CredentialCipher {
  readonly #keyProvider: KeyProvider;
  readonly #currentVersion = 1;

  constructor(keyProvider: KeyProvider) {
    this.#keyProvider = keyProvider;
  }

  /**
   * Encrypts a plaintext credential string.
   *
   * Returns an `EncryptedBlob` with all binary fields base64-encoded.
   * Two calls with the same plaintext produce entirely different blobs
   * (fresh data key + fresh IV each time).
   */
  async encrypt(
    plaintext: string,
    owner: CredentialOwner,
  ): Promise<EncryptedBlob> {
    const plaintextBytes = textEncoder.encode(plaintext);
    const ownerAdditionalData = this.#ownerAdditionalData(owner);
    // 1. Generate a fresh random 256-bit data key.
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    // 2. Generate a fresh 96-bit initialization vector.
    const initializationVector = crypto.getRandomValues(new Uint8Array(12));

    // 3. Import the data key for encryption.
    const dataCryptoKey = await crypto.subtle.importKey(
      "raw",
      dataKey as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );

    // 4. Encrypt the plaintext under the data key.
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: initializationVector as BufferSource,
        additionalData: ownerAdditionalData as BufferSource,
      },
      dataCryptoKey,
      plaintextBytes as BufferSource,
    );

    // 5. Wrap the data key via the KeyProvider.
    const wrappedDataKey = await this.#keyProvider.wrapDataKey(dataKey, owner);

    return {
      v: this.#currentVersion,
      wrappedDataKey: encodeBase64(wrappedDataKey),
      iv: encodeBase64(initializationVector),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  }

  /**
   * Decrypts an `EncryptedBlob` back to the original plaintext string.
   *
   * Throws if any field is malformed, the version is unsupported, or
   * authentication fails (GCM tag mismatch).
   */
  async decrypt(blob: EncryptedBlob, owner: CredentialOwner): Promise<string> {
    if (blob.v !== this.#currentVersion) {
      throw new Error(
        `Unsupported EncryptedBlob version: ${blob.v} (expected ${this.#currentVersion})`,
      );
    }

    const decoder = new TextDecoder();

    const ownerAdditionalData = this.#ownerAdditionalData(owner);

    // Base64-decode all fields.
    let wrappedDataKeyBytes: Uint8Array;
    let initializationVector: Uint8Array;
    let ciphertextWithTag: Uint8Array;
    try {
      wrappedDataKeyBytes = decodeBase64(blob.wrappedDataKey);
      initializationVector = decodeBase64(blob.iv);
      ciphertextWithTag = decodeBase64(blob.ciphertext);
    } catch (cause) {
      throw new Error("Failed to decode base64 fields in EncryptedBlob", { cause });
    }

    if (initializationVector.length !== 12) {
      throw new Error(
        `IV must be 12 bytes, got ${initializationVector.length}`,
      );
    }

    // 1. Unwrap the data key via the KeyProvider.
    // 2. Import the unwrapped data key for decryption.
    // 3. Decrypt. GCM authentication is verified by WebCrypto — a tampered
    //    ciphertext, IV, or wrapped key will throw, never return garbage.
    let plaintextBytes: ArrayBuffer;
    try {
      const dataKeyBytes = await this.#keyProvider.unwrapDataKey(
        wrappedDataKeyBytes,
        owner,
      );

      const dataCryptoKey = await crypto.subtle.importKey(
        "raw",
        dataKeyBytes as BufferSource,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );

      plaintextBytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: initializationVector as BufferSource,
          additionalData: ownerAdditionalData as BufferSource,
        },
        dataCryptoKey,
        ciphertextWithTag as BufferSource,
      );
    } catch (cause) {
      throw new Error(
        "Decryption failed — ciphertext may be tampered or the key is wrong",
        { cause },
      );
    }

    return decoder.decode(plaintextBytes);
  }

  #ownerAdditionalData(owner: CredentialOwner): Uint8Array {
    return textEncoder.encode(JSON.stringify([owner.userId, owner.connectorId]));
  }
}