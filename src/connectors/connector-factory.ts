import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import {
  getDecryptedCredentialSnapshot,
  getDecryptedCredentials,
  type PublicSource,
} from "../repositories/source-repository.ts";
import type { XContentCache } from "../repositories/x-content-cache-repository.ts";
import { DatabaseXContentCache } from "../repositories/x-content-cache-repository.ts";
import { ConflictError } from "../server/errors.ts";
import type { Connector } from "./connector.types.ts";
import {
  type SubstackCredentials,
  substackCredentialSchema,
  telegramCredentialSchema,
  xCredentialSchema,
} from "./credential-schemas.ts";
import type { TelegramConnector } from "./telegram/telegram-connector.ts";
import type { TelegramConnectorRawData } from "./telegram/telegram-connector.types.ts";
import { destroyTelegramClient } from "./telegram/client-factory.ts";
import type {
  PublicationPageReader,
  SubstackPostReader,
  SubstackRawData,
} from "./substack/substack-connector.ts";
import type { TwexFetch, XApiClient } from "./x/twex-api-client.ts";
import { TwexApiClient } from "./x/twex-api-client.ts";
import { XConnector } from "./x/x-connector.ts";
import type { XCredentials } from "./x/x.types.ts";

export type TelegramClientHandle = ConstructorParameters<
  typeof TelegramConnector
>[0];

export interface ConnectorHandle<TRawData = unknown> {
  connector: Connector<TRawData>;
  ingestionMode: "batch" | "individual";
  sourceCredentialRevision?: number;
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
  async createClientFromSession(
    sessionString: string,
  ): Promise<TelegramClientHandle> {
    try {
      // Deliberately lazy: GramJS is loaded only when a Telegram connector is requested.
      const { createClientFromSession } = await import(
        "./telegram/client-factory.ts"
      );
      return await createClientFromSession(sessionString);
    } catch (error) {
      throw new Error("Failed to load Telegram client factory", {
        cause: error,
      });
    }
  }
}

class DefaultSubstackClientFactory implements SubstackClientFactory {
  async createClient(
    credentials: SubstackCredentials,
  ): Promise<SubstackPostReader> {
    const { SubstackSessionClient } = await import(
      "./substack/session-client.ts"
    );
    return new SubstackSessionClient(credentials);
  }
}

const defaultSubstackPublicationReader: PublicationPageReader = async (
  publicationUrl,
  offset,
  limit,
  signal,
) => {
  const { readPublicArchive } = await import(
    "./substack/publication-reader.ts"
  );
  return await readPublicArchive(publicationUrl, {}, offset, limit, signal);
};

export interface XApiClientFactory {
  createClient(
    credentials: Pick<XCredentials, "apiKey" | "authToken" | "cookie" | "pin">,
    options?: { baseUrl?: string; fetch?: TwexFetch },
  ): XApiClient;
}

export interface XContentCacheFactory {
  createCache(
    database: Database,
    sourceId: string,
    expectedCredentialRevision?: number,
  ): XContentCache;
}

export function defaultXApiClientFactory(baseUrl?: string): XApiClientFactory {
  return {
    createClient(credentials, options) {
      return new TwexApiClient(credentials, {
        ...options,
        baseUrl: options?.baseUrl ?? baseUrl,
      });
    },
  };
}

export function defaultXContentCacheFactory(): XContentCacheFactory {
  return {
    createCache(database, sourceId, expectedCredentialRevision) {
      return new DatabaseXContentCache(
        database,
        sourceId,
        expectedCredentialRevision,
      );
    },
  };
}

export interface ConnectorFactoryDependencies {
  credentialCipher?: CredentialCipher;
  telegramClientFactory?: TelegramClientFactory;
  substackClientFactory?: SubstackClientFactory;
  substackPublicationReader?: PublicationPageReader;
  twexApiBaseUrl?: string;
  xApiClientFactory?: XApiClientFactory;
  xContentCacheFactory?: XContentCacheFactory;
}

export class ConnectorFactory {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #telegramClientFactory: TelegramClientFactory;
  readonly #substackClientFactory: SubstackClientFactory;
  readonly #substackPublicationReader: PublicationPageReader;
  readonly #xApiClientFactory: XApiClientFactory;
  readonly #xContentCacheFactory: XContentCacheFactory;

  constructor(
    database: Database,
    dependencies: ConnectorFactoryDependencies = {},
  ) {
    this.#database = database;
    this.#credentialCipher = dependencies.credentialCipher ??
      new CredentialCipher(new EnvMasterKeyProvider());
    this.#telegramClientFactory = dependencies.telegramClientFactory ??
      new DefaultTelegramClientFactory();
    this.#substackClientFactory = dependencies.substackClientFactory ??
      new DefaultSubstackClientFactory();
    this.#substackPublicationReader = dependencies.substackPublicationReader ??
      defaultSubstackPublicationReader;
    this.#xApiClientFactory = dependencies.xApiClientFactory ??
      defaultXApiClientFactory(dependencies.twexApiBaseUrl);
    this.#xContentCacheFactory = dependencies.xContentCacheFactory ??
      defaultXContentCacheFactory();
  }

  async forSource(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle> {
    switch (source.connectorId) {
      case ConnectorId.Telegram:
        return await this.#telegramConnector(source, userId);
      case ConnectorId.Substack:
        return await this.#substackConnector(source, userId);
      case ConnectorId.X:
        return await this.#xConnector(source, userId);
      default:
        throw new ConflictError(
          `connector is not supported: ${source.connectorId}`,
        );
    }
  }

  async #telegramConnector(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle<TelegramConnectorRawData>> {
    const credentials = telegramCredentialSchema.parse(
      await getDecryptedCredentials(
        this.#database,
        source.id,
        userId,
        this.#credentialCipher,
      ),
    );
    const client = await this.#telegramClientFactory.createClientFromSession(
      credentials.sessionString,
    );
    let TelegramConnectorClass: typeof TelegramConnector;
    try {
      // Deliberately lazy: Telegram connector code and GramJS are used only for Telegram ingestion.
      ({ TelegramConnector: TelegramConnectorClass } = await import(
        "./telegram/telegram-connector.ts"
      ));
    } catch (error) {
      await destroyTelegramClient(client);
      throw new Error("Failed to load Telegram connector", { cause: error });
    }
    return {
      connector: new TelegramConnectorClass(client),
      ingestionMode: "batch",
      dispose: async () => await destroyTelegramClient(client),
    };
  }

  async #xConnector(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle> {
    const credentialSnapshot = await getDecryptedCredentialSnapshot(
      this.#database,
      source.id,
      userId,
      this.#credentialCipher,
    );
    const credentials = xCredentialSchema.parse(
      credentialSnapshot.credentials,
    );
    const client = this.#xApiClientFactory.createClient({
      apiKey: credentials.apiKey,
      authToken: credentials.authToken,
      cookie: credentials.cookie,
      pin: credentials.pin,
    });
    const cache = this.#xContentCacheFactory.createCache(
      this.#database,
      source.id,
      credentialSnapshot.credentialRevision,
    );
    const connector = new XConnector(client, cache, credentials.listQuery);
    return {
      connector,
      ingestionMode: "batch",
      sourceCredentialRevision: credentialSnapshot.credentialRevision,
      dispose: async () => await connector.dispose(),
    };
  }

  async #substackConnector(
    source: PublicSource,
    userId: string,
  ): Promise<ConnectorHandle<SubstackRawData>> {
    const credentials = substackCredentialSchema.parse(
      await getDecryptedCredentials(
        this.#database,
        source.id,
        userId,
        this.#credentialCipher,
      ),
    );
    const client = await this.#substackClientFactory.createClient(credentials);
    const { SubstackConnector } = await import(
      "./substack/substack-connector.ts"
    );
    return {
      connector: new SubstackConnector(client, this.#substackPublicationReader),
      ingestionMode: "individual",
    };
  }
}
