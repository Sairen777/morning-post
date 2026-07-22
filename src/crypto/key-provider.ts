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

/**
 * KeyProvider wraps and unwraps per-user data keys.
 *
 * Owner metadata is mandatory at this seam so a KMS-backed provider can mirror
 * credential owner binding in its encryption context / labels. The env-backed
 * bootstrap provider accepts the metadata but does not need it at runtime.
 *
 * The interface is the seam: swap the env-backed provider for a KMS-backed one
 * (AWS KMS, GCP KMS, Vault Transit) without changing CredentialCipher.
 */
export interface CredentialOwner {
  userId: string;
  connectorId: string;
}

export interface KeyProvider {
  wrapDataKey(
    dataKey: Uint8Array,
    owner: CredentialOwner,
  ): Promise<Uint8Array>;
  unwrapDataKey(
    wrappedKey: Uint8Array,
    owner: CredentialOwner,
  ): Promise<Uint8Array>;
}

/**
 * Bootstrap KeyProvider that reads a base64-encoded 32-byte master key from
 * the environment variable `CREDENTIAL_MASTER_KEY` or from a constructor argument.
 *
 * Precedence: constructor argument → CREDENTIAL_MASTER_KEY env → error.
 *
 * ---
 *
 * ## Security note (read before deploying)
 *
 * **The master key should NEVER live on the VPS disk.**
 *
 * This provider exists for v1 bootstrapping and local development. A KMS-backed
 * provider would call out to the KMS's encrypt/decrypt endpoint with owner
 * metadata as encryption context, so the key material never enters this process.
 * The `KeyProvider` interface is designed exactly as that swap point: write a
 * `KmsKeyProvider` that implements these two methods, and `CredentialCipher`
 * needs no changes.
 *
 * Holding the master key on the VPS (even env-only) means a rooted host can read
 * it. The KMS limits exposure to online-only and enables instant revocation:
 * revoke the KMS key and every stored credential is dead. See ARCHITECTURE.md
 * "Credentials & secrets" for the full threat model.
 *
 * ## Generating a good master key
 *
 * ```
 * openssl rand -base64 32
 * ```
 *
 * This produces a 256-bit key, base64-encoded (44 characters, one '=' pad).
 *
 * ---
 *
 * ## Wire format
 *
 * `wrapDataKey` encrypts the data key under the master key with AES-256-GCM.
 * A fresh 96-bit IV is generated per call. WebCrypto appends the 16-byte
 * authentication tag to the ciphertext, so the return value is:
 *
 *   `IV (12 bytes) || ciphertext || tag (16 bytes)`
 *
 * `unwrapDataKey` splits the IV, feeds `ciphertext || tag` to WebCrypto,
 * which verifies the tag and strips it.
 *
 * Owner metadata is accepted by the env provider for interface parity with KMS
 * providers; CredentialCipher performs the mandatory AES-GCM owner binding.
 */
export class EnvMasterKeyProvider implements KeyProvider {
  readonly #masterKey: Promise<CryptoKey>;

  /**
   * @param masterKeyBytes If provided, used directly. Otherwise reads
   *   `CREDENTIAL_MASTER_KEY` from the environment. Throws if neither is available.
   */
  constructor(masterKeyBytes?: Uint8Array) {
    let raw: Uint8Array;

    if (masterKeyBytes !== undefined && masterKeyBytes.length > 0) {
      raw = masterKeyBytes;
    } else {
      const encoded = process.env["CREDENTIAL_MASTER_KEY"];
      if (!encoded) {
        throw new Error(
          "CREDENTIAL_MASTER_KEY environment variable is not set and no key was " +
            "provided to the constructor",
        );
      }
      try {
        raw = decodeBase64(encoded);
      } catch (cause) {
        throw new Error(
          "CREDENTIAL_MASTER_KEY is not valid base64",
          { cause },
        );
      }
    }

    if (raw.length !== 32) {
      throw new Error(
        `CREDENTIAL_MASTER_KEY must be 32 bytes (256 bits), got ${raw.length}`,
      );
    }

    // Import the raw bytes as an AES-GCM key. We use encrypt/decrypt (not
    // wrapKey/unwrapKey) because WebCrypto's wrapKey expects a CryptoKey as
    // input, but our data keys are raw random bytes (not imported keys).
    this.#masterKey = crypto.subtle.importKey(
      "raw",
      raw as BufferSource,
      { name: "AES-GCM" },
      false, // not extractable
      ["encrypt", "decrypt"],
    );
  }

  /** Returns the already-imported master key (await the promise it wraps). */
  async #master(): Promise<CryptoKey> {
    return await this.#masterKey;
  }

  async wrapDataKey(
    dataKey: Uint8Array,
    _owner: CredentialOwner,
  ): Promise<Uint8Array> {
    const master = await this.#master();

    // Generate a fresh 96-bit IV per wrapping operation.
    const initializationVector = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt the raw data key bytes with AES-256-GCM.
    // We use encrypt() rather than wrapKey() because wrapKey expects a CryptoKey
    // as input, and our data keys are raw random bytes — not imported keys.
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: initializationVector as BufferSource },
      master,
      dataKey as BufferSource,
    );

    // Return: IV (12) || ciphertext || tag (16) — WebCrypto appends the tag.
    const wrapped = new Uint8Array(
      initializationVector.length + ciphertext.byteLength,
    );
    wrapped.set(initializationVector, 0);
    wrapped.set(new Uint8Array(ciphertext), initializationVector.length);
    return wrapped;
  }

  async unwrapDataKey(
    wrappedKey: Uint8Array,
    _owner: CredentialOwner,
  ): Promise<Uint8Array> {
    const master = await this.#master();

    // Minimum size: 12 (IV) + 1 (at least one ciphertext block) + 16 (tag) = 29.
    if (wrappedKey.length < 29) {
      throw new Error("Wrapped data key is too short for AES-256-GCM");
    }

    const initializationVector = wrappedKey.slice(0, 12);
    const ciphertextWithTag = wrappedKey.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: initializationVector },
      master,
      ciphertextWithTag,
    );

    return new Uint8Array(plaintext);
  }
}
