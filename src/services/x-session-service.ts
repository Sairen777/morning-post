import { z } from "zod";
import type { XCredentials } from "../connectors/x/x.types.ts";
import { throwIfAborted } from "../connectors/x/abort.ts";
import {
  TwexApiClient,
  TwexApiError,
} from "../connectors/x/twex-api-client.ts";
import {
  requireXCookieAuthTokenMatch,
  xCookieSchema,
  xCredentialSchema,
} from "../connectors/credential-schemas.ts";
import {
  type XContentCacheFactory,
  defaultXContentCacheFactory,
} from "../connectors/connector-factory.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import { resetFeedsForSourceConnection } from "../repositories/feed-repository.ts";
import {
  findSourceCredentialStateByConnectorId,
  getDecryptedCredentialSnapshot,
  type PublicSource,
  upsertSourceCredentials,
} from "../repositories/source-repository.ts";
import { ConflictError, ValidationError } from "../server/errors.ts";
import { commitImmediately, type ConnectorCommit } from "./connector-commit.ts";

const API_KEY_MAX_LENGTH = 2_048;
const AUTH_TOKEN_MAX_LENGTH = 2_048;
const PIN_MAX_LENGTH = 64;
const LIST_QUERY_MAX_LENGTH = 500;

export const xSessionInputSchema = z.object({
  apiKey: z.string().min(1, "apiKey is required").max(
    API_KEY_MAX_LENGTH,
    "apiKey is too long",
  ),
  authToken: z.string().min(1, "authToken is required").max(
    AUTH_TOKEN_MAX_LENGTH,
    "authToken is too long",
  ),
  cookie: xCookieSchema,
  pin: z.string().min(1, "pin must not be empty").max(
    PIN_MAX_LENGTH,
    "pin is too long",
  ).optional(),
  listQuery: z.string().max(
    LIST_QUERY_MAX_LENGTH,
    "listQuery is too long",
  ).optional(),
}).strict().superRefine(requireXCookieAuthTokenMatch);

export type XSessionInput = z.infer<typeof xSessionInputSchema>;

export interface XSessionValidator {
  validate(signal?: AbortSignal): Promise<{ userId: string; username: string }>;
}

export interface XSessionValidatorFactory {
  create(input: XSessionInput): XSessionValidator;
}

function defaultValidatorFactory(baseUrl?: string): XSessionValidatorFactory {
  return {
    create: (input) => ({
      async validate(signal) {
        const client = new TwexApiClient(
          {
            apiKey: input.apiKey,
            authToken: input.authToken,
            cookie: input.cookie,
            ...(input.pin === undefined ? {} : { pin: input.pin }),
          },
          baseUrl === undefined ? undefined : { baseUrl },
        );
        const user = await client.getUserInfo(signal);
        return { userId: user.userId, username: user.username };
      },
    }),
  };
}

/** Credential-style failures the upstream reports with a 4xx status. */
function isCredentialFailure(error: TwexApiError): boolean {
  return error.status !== undefined && error.status >= 400 && error.status < 500 ||
    error.code !== undefined && error.code >= 400 && error.code < 500;
}

export interface XSessionServiceOptions {
  database: Database;
  credentialCipher?: CredentialCipher;
  validatorFactory?: XSessionValidatorFactory;
  contentCacheFactory?: XContentCacheFactory;
  baseUrl?: string;
}

export class XSessionService {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #validatorFactory: XSessionValidatorFactory;
  readonly #contentCacheFactory: XContentCacheFactory;

  constructor(options: XSessionServiceOptions) {
    this.#database = options.database;
    this.#credentialCipher = options.credentialCipher ??
      new CredentialCipher(new EnvMasterKeyProvider());
    this.#validatorFactory = options.validatorFactory ??
      defaultValidatorFactory(options.baseUrl);
    this.#contentCacheFactory = options.contentCacheFactory ??
      defaultXContentCacheFactory();
  }

  async connect(
    userId: string,
    input: XSessionInput,
    signal?: AbortSignal,
    commitOperation: ConnectorCommit = commitImmediately,
  ): Promise<PublicSource> {
    throwIfAborted(signal);
    const parsedInput = xSessionInputSchema.parse(input);
    let user: { userId: string; username: string };
    try {
      user = await this.#validatorFactory.create(parsedInput).validate(signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof TwexApiError) {
        if (isCredentialFailure(error)) {
          throw new ValidationError("X credentials are invalid or expired");
        }
        // Upstream availability failures keep their identity for ops.
        throw error;
      }
      throw new ValidationError("X credentials are invalid or expired");
    }
    throwIfAborted(signal);

    const existingState = findSourceCredentialStateByConnectorId(
      this.#database,
      userId,
      ConnectorId.X,
    );
    let previousUserId: string | null = null;
    if (existingState) {
      try {
        previousUserId = xCredentialSchema.parse(
          (await getDecryptedCredentialSnapshot(
            this.#database,
            existingState.sourceId,
            userId,
            this.#credentialCipher,
          )).credentials,
        ).xUserId;
      } catch {
        // Legacy profileId-era credentials, undecryptable blobs, or a
        // disconnected source all mean the cache belongs to an unknown
        // account: it must not survive the reconnect.
      }
    }
    throwIfAborted(signal);
    // Only a present, decryptable credential with the same xUserId may keep
    // the source-scoped cache and feed subscriptions.
    const resetAccountScopedData = existingState !== null &&
      previousUserId !== user.userId;

    const storedCredentials: XCredentials = {
      apiKey: parsedInput.apiKey,
      authToken: parsedInput.authToken,
      cookie: parsedInput.cookie,
      ...(parsedInput.pin === undefined ? {} : { pin: parsedInput.pin }),
      listQuery: parsedInput.listQuery?.trim() || user.username,
      xUserId: user.userId,
      xUsername: user.username,
    };
    throwIfAborted(signal);
    const encryptedCredentials = await this.#credentialCipher.encrypt(
      JSON.stringify(xCredentialSchema.parse(storedCredentials)),
      { userId, connectorId: ConnectorId.X },
    );
    throwIfAborted(signal);
    return await commitOperation(() => {
      throwIfAborted(signal);
      return this.#database.transaction((transaction) => {
        const transactionalDatabase = transaction as Database;
        const currentState = findSourceCredentialStateByConnectorId(
          transactionalDatabase,
          userId,
          ConnectorId.X,
        );
        if (
          currentState?.sourceId !== existingState?.sourceId ||
          currentState?.credentialRevision !== existingState?.credentialRevision ||
          currentState?.connected !== existingState?.connected
        ) {
          throw new ConflictError(
            "X connection changed while reconnecting; retry",
          );
        }
        if (resetAccountScopedData && existingState) {
          this.#contentCacheFactory.createCache(
            transactionalDatabase,
            existingState.sourceId,
          ).clear();
          resetFeedsForSourceConnection(
            transactionalDatabase,
            existingState.sourceId,
          );
        }
        return upsertSourceCredentials(transactionalDatabase, {
          userId,
          connectorId: ConnectorId.X,
          credentials: encryptedCredentials,
        });
      }, { behavior: "immediate" });
    });
  }
}
