import {
  type SubstackCredentials,
  substackCredentialSchema,
} from "../connectors/credential-schemas.ts";
import { SubstackSessionClient } from "../connectors/substack/session-client.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import {
  type PublicSource,
  upsertSourceCredentials,
} from "../repositories/source-repository.ts";
import { ValidationError } from "../server/errors.ts";
import {
  type ConnectorCommit,
  commitImmediately,
} from "./connector-commit.ts";

export interface SubstackSessionValidator {
  validateSession(signal?: AbortSignal): Promise<{ userId: number }>;
}

export interface SubstackSessionValidatorFactory {
  create(credentials: SubstackCredentials): SubstackSessionValidator;
}

const defaultValidatorFactory: SubstackSessionValidatorFactory = {
  create: (credentials) => new SubstackSessionClient(credentials),
};

export class SubstackSessionService {
  constructor(
    private readonly database: Database,
    private readonly validatorFactory: SubstackSessionValidatorFactory = defaultValidatorFactory,
    private readonly credentialCipher = new CredentialCipher(new EnvMasterKeyProvider()),
  ) {}

  async connect(
    userId: string,
    credentials: SubstackCredentials,
    signal?: AbortSignal,
    commitOperation: ConnectorCommit = commitImmediately,
  ): Promise<PublicSource> {
    const parsedCredentials = substackCredentialSchema.parse(credentials);
    try {
      await this.validatorFactory.create(parsedCredentials).validateSession(signal);
      if (signal?.aborted) {
        throw new Error("Substack session validation was aborted");
      }
    } catch {
      throw new ValidationError("Substack session is invalid or expired");
    }

    const encryptedCredentials = await this.credentialCipher.encrypt(
      JSON.stringify(parsedCredentials),
      { userId, connectorId: ConnectorId.Substack },
    );
    if (signal?.aborted) {
      throw new ValidationError("Substack session is invalid or expired");
    }
    return await commitOperation(() =>
      upsertSourceCredentials(this.database, {
        userId,
        connectorId: ConnectorId.Substack,
        credentials: encryptedCredentials,
      })
    );
  }
}
