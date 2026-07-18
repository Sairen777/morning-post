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
import {
  substackCredentialSchema,
  telegramCredentialSchema,
  type SubstackCredentials,
} from "./credential-schemas.ts";
import type { TelegramConnector } from "./telegram/telegram-connector.ts";
import type { TelegramConnectorRawData } from "./telegram/telegram-connector.types.ts";
import type {
  PublicationPageReader,
  SubstackPostReader,
  SubstackRawData,
} from "./substack/substack-connector.ts";

export type TelegramClientHandle = ConstructorParameters<typeof TelegramConnector>[0];

export interface ConnectorHandle<TRawData = unknown> {
  connector: Connector<TRawData>;
  ingestionMode: "batch" | "individual";
  dispose?(): Promise<void> | void;
}

export interface ConnectorFactoryLike {
  forSource(source: PublicSource, userId: string): Promise<ConnectorHandle>;
}

export interface TelegramClientFactory {
  createClientFromSession(sessionString: string): Promise<TelegramClientHandle>;
}

export interface SubstackClientFactory {
  createClient(credentials: SubstackCredentials): Promise<SubstackPostReader>;
}

class DefaultTelegramClientFactory implements TelegramClientFactory {
  async createClientFromSession(sessionString: string): Promise<TelegramClientHandle> {
    try {
      // Deliberately lazy: GramJS is loaded only when a Telegram connector is requested.
      const { createClientFromSession } = await import("./telegram/client-factory.ts");
      return await createClientFromSession(sessionString);
    } catch (error) {
      throw new Error("Failed to load Telegram client factory", { cause: error });
    }
  }
}

class DefaultSubstackClientFactory implements SubstackClientFactory {
  async createClient(credentials: SubstackCredentials): Promise<SubstackPostReader> {
    const { SubstackSessionClient } = await import("./substack/session-client.ts");
    return new SubstackSessionClient(credentials);
  }
}

const defaultSubstackPublicationReader: PublicationPageReader = async (
  publicationUrl,
  offset,
  limit,
  signal,
) => {
  const { readPublicArchive } = await import("./substack/publication-reader.ts");
  return await readPublicArchive(publicationUrl, {}, offset, limit, signal);
};

export interface ConnectorFactoryDependencies {
  credentialCipher?: CredentialCipher;
  telegramClientFactory?: TelegramClientFactory;
  substackClientFactory?: SubstackClientFactory;
  substackPublicationReader?: PublicationPageReader;
}

export class ConnectorFactory {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #telegramClientFactory: TelegramClientFactory;
  readonly #substackClientFactory: SubstackClientFactory;
  readonly #substackPublicationReader: PublicationPageReader;

  constructor(database: Database, dependencies: ConnectorFactoryDependencies = {}) {
    this.#database = database;
    this.#credentialCipher = dependencies.credentialCipher ?? new CredentialCipher(new EnvMasterKeyProvider());
    this.#telegramClientFactory = dependencies.telegramClientFactory ?? new DefaultTelegramClientFactory();
    this.#substackClientFactory = dependencies.substackClientFactory ?? new DefaultSubstackClientFactory();
    this.#substackPublicationReader = dependencies.substackPublicationReader ?? defaultSubstackPublicationReader;
  }

  async forSource(source: PublicSource, userId: string): Promise<ConnectorHandle> {
    switch (source.connectorId) {
      case ConnectorId.Telegram:
        return await this.#telegramConnector(source, userId);
      case ConnectorId.Substack:
        return await this.#substackConnector(source, userId);
      default:
        throw new ConflictError(`connector is not supported: ${source.connectorId}`);
    }
  }

  async #telegramConnector(source: PublicSource, userId: string): Promise<ConnectorHandle<TelegramConnectorRawData>> {
    const credentials = telegramCredentialSchema.parse(
      await getDecryptedCredentials(this.#database, source.id, userId, this.#credentialCipher),
    );
    const client = await this.#telegramClientFactory.createClientFromSession(credentials.sessionString);
    let TelegramConnectorClass: typeof TelegramConnector;
    try {
      // Deliberately lazy: Telegram connector code and GramJS are used only for Telegram ingestion.
      ({ TelegramConnector: TelegramConnectorClass } = await import("./telegram/telegram-connector.ts"));
    } catch (error) {
      throw new Error("Failed to load Telegram connector", { cause: error });
    }
    return {
      connector: new TelegramConnectorClass(client),
      ingestionMode: "batch",
      dispose: async () => await client.disconnect(),
    };
  }

  async #substackConnector(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle<SubstackRawData>> {
    const credentials = substackCredentialSchema.parse(
      await getDecryptedCredentials(this.#database, source.id, userId, this.#credentialCipher),
    );
    const client = await this.#substackClientFactory.createClient(credentials);
    const { SubstackConnector } = await import("./substack/substack-connector.ts");
    return {
      connector: new SubstackConnector(client, this.#substackPublicationReader),
      ingestionMode: "individual",
    };
  }
}
