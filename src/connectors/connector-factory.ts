import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import {
  getDecryptedCredentials,
  type PublicSource,
} from "../repositories/source-repository.ts";
import { ConflictError } from "../server/errors.ts";
import type { Connector } from "./connector.types.ts";
import { createClientFromSession } from "./telegram/client-factory.ts";
import { TelegramConnector } from "./telegram/telegram-connector.ts";
import type { TelegramConnectorRawData } from "./telegram/telegram-connector.types.ts";

export type TelegramClientHandle = ConstructorParameters<typeof TelegramConnector>[0];

export interface ConnectorHandle<TRawData = unknown> {
  connector: Connector<TRawData>;
  dispose?(): Promise<void> | void;
}

export interface ConnectorFactoryLike {
  forSource(source: PublicSource, userId: string): Promise<ConnectorHandle>;
}

export interface TelegramClientFactory {
  createClientFromSession(sessionString: string): Promise<TelegramClientHandle>;
}

class DefaultTelegramClientFactory implements TelegramClientFactory {
  async createClientFromSession(sessionString: string): Promise<TelegramClientHandle> {
    return await createClientFromSession(sessionString);
  }
}

export interface ConnectorFactoryDependencies {
  credentialCipher?: CredentialCipher;
  telegramClientFactory?: TelegramClientFactory;
}

export class ConnectorFactory {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #telegramClientFactory: TelegramClientFactory;

  constructor(database: Database, dependencies: ConnectorFactoryDependencies = {}) {
    this.#database = database;
    this.#credentialCipher = dependencies.credentialCipher ?? new CredentialCipher(new EnvMasterKeyProvider());
    this.#telegramClientFactory = dependencies.telegramClientFactory ?? new DefaultTelegramClientFactory();
  }

  async forSource(source: PublicSource, userId: string): Promise<ConnectorHandle> {
    switch (source.connectorId) {
      case ConnectorId.Telegram:
        return await this.#telegramConnector(source, userId);
      default:
        throw new ConflictError(`connector is not supported: ${source.connectorId}`);
    }
  }

  async #telegramConnector(source: PublicSource, userId: string): Promise<ConnectorHandle<TelegramConnectorRawData>> {
    const credentials = await getDecryptedCredentials(this.#database, source.id, userId, this.#credentialCipher);
    const client = await this.#telegramClientFactory.createClientFromSession(credentials.sessionString);
    return {
      connector: new TelegramConnector(client),
      dispose: async () => await client.disconnect(),
    };
  }
}
