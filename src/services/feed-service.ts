import type {
  AvailableFeed,
  Connector,
} from "../connectors/connector.types.ts";
import {
  telegramCredentialSchema,
  xCredentialSchema,
} from "../connectors/credential-schemas.ts";
import {
  type createClientFromSession as CreateClientFromSession,
  destroyTelegramClient,
} from "../connectors/telegram/client-factory.ts";
import type { TelegramConnector as TelegramConnectorClass } from "../connectors/telegram/telegram-connector.ts";
import {
  type XApiClientFactory,
  type XContentCacheFactory,
  defaultXApiClientFactory,
  defaultXContentCacheFactory,
} from "../connectors/connector-factory.ts";
import { XConnector } from "../connectors/x/x-connector.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import {
  createOrReviveFeed,
  type CreateOrReviveFeedInput,
  type PublicFeed,
  softDeleteFeed,
} from "../repositories/feed-repository.ts";
import {
  assertSourceConnectedRevision,
  assertSourceConnectionRevision,
  findSourceById,
  getDecryptedCredentialSnapshot,
  getDecryptedCredentials,
  type PublicSource,
} from "../repositories/source-repository.ts";
import { replaceDiscoveredFeedsForRevision } from "../repositories/x-discovered-feed-repository.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";

export interface TelegramFeedDiscoveryRuntime {
  createClientFromSession: typeof CreateClientFromSession;
  TelegramConnector: typeof TelegramConnectorClass;
}

export type TelegramFeedDiscoveryRuntimeLoader = () => Promise<
  TelegramFeedDiscoveryRuntime
>;

const loadTelegramFeedDiscoveryRuntime: TelegramFeedDiscoveryRuntimeLoader =
  async () => {
    // Deliberately lazy: feed discovery loads GramJS only when the discovery endpoint is used.
    const { createClientFromSession } = await import(
      "../connectors/telegram/client-factory.ts"
    );
    const { TelegramConnector } = await import(
      "../connectors/telegram/telegram-connector.ts"
    );
    return { createClientFromSession, TelegramConnector };
  };

export interface XFeedDiscoveryOptions {
  twexApiBaseUrl?: string;
  xApiClientFactory?: XApiClientFactory;
  xContentCacheFactory?: XContentCacheFactory;
}

export interface FeedDiscoveryHandle {
  connector: Pick<Connector<unknown>, "listAvailableFeeds">;
  sourceCredentialRevision?: number;
  dispose?(): Promise<void> | void;
}

export interface FeedDiscoveryFactory {
  create(source: PublicSource, userId: string): Promise<FeedDiscoveryHandle>;
}

export class DefaultFeedDiscoveryFactory implements FeedDiscoveryFactory {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #runtimeLoader: TelegramFeedDiscoveryRuntimeLoader;
  readonly #xApiClientFactory: XApiClientFactory;
  readonly #xContentCacheFactory: XContentCacheFactory;

  constructor(
    database: Database,
    credentialCipher = new CredentialCipher(new EnvMasterKeyProvider()),
    runtimeLoader: TelegramFeedDiscoveryRuntimeLoader =
      loadTelegramFeedDiscoveryRuntime,
    options: XFeedDiscoveryOptions = {},
  ) {
    this.#database = database;
    this.#credentialCipher = credentialCipher;
    this.#runtimeLoader = runtimeLoader;
    this.#xApiClientFactory = options.xApiClientFactory ??
      defaultXApiClientFactory(options.twexApiBaseUrl);
    this.#xContentCacheFactory = options.xContentCacheFactory ??
      defaultXContentCacheFactory();
  }

  async create(
    source: PublicSource,
    userId: string,
  ): Promise<FeedDiscoveryHandle> {
    if (source.connectorId === ConnectorId.X) {
      return await this.#createX(source, userId);
    }
    if (source.connectorId !== ConnectorId.Telegram) {
      throw new ConflictError(
        "source connector does not support feed discovery",
      );
    }

    const credentials = await getDecryptedCredentials(
      this.#database,
      source.id,
      userId,
      this.#credentialCipher,
    );
    let runtime: TelegramFeedDiscoveryRuntime;
    try {
      runtime = await this.#runtimeLoader();
    } catch (error) {
      throw new Error("Failed to load Telegram feed discovery connector", {
        cause: error,
      });
    }
    const telegramCredentials = telegramCredentialSchema.parse(credentials);
    const client = await runtime.createClientFromSession(
      telegramCredentials.sessionString,
    );
    try {
      return {
        connector: new runtime.TelegramConnector(client),
        dispose: async () => await destroyTelegramClient(client),
      };
    } catch (error) {
      await destroyTelegramClient(client);
      throw error;
    }
  }

  async #createX(
    source: PublicSource,
    userId: string,
  ): Promise<FeedDiscoveryHandle> {
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
      sourceCredentialRevision: credentialSnapshot.credentialRevision,
      dispose: async () => await connector.dispose(),
    };
  }
}

export async function discoverFeeds(
  database: Database,
  userId: string,
  sourceId: string,
  discoveryFactory: FeedDiscoveryFactory = new DefaultFeedDiscoveryFactory(
    database,
  ),
  signal?: AbortSignal,
): Promise<AvailableFeed[]> {
  const source = await findSourceById(database, sourceId, userId);
  if (!source) {
    throw new NotFoundError("source not found");
  }
  if (source.connectorId === ConnectorId.Substack) {
    throw new ConflictError(
      "Substack publications must be added through the Substack connector",
    );
  }

  const handle = await discoveryFactory.create(source, userId);
  try {
    if (!handle.connector.listAvailableFeeds) {
      throw new ConflictError(
        "source connector does not support feed discovery",
      );
    }
    const availableFeeds = await handle.connector.listAvailableFeeds(signal);
    const sourceCredentialRevision = handle.sourceCredentialRevision;
    if (source.connectorId === ConnectorId.X &&
        sourceCredentialRevision !== undefined) {
      // Catalog authorization: after a successful discovery, revalidate the
      // source is still connected under the exact revision the discovery ran
      // under, then atomically replace the source's catalog with exactly the
      // returned lists/group chats. Revalidation and replacement share one
      // immediate transaction, so a reconnect, disconnect, or reset that
      // lands meanwhile fails the revalidation and rolls the replace back;
      // no additional upstream call is made beyond the discovery itself.
      database.transaction((transaction) => {
        const transactionalDatabase = transaction as Database;
        assertSourceConnectedRevision(
          transactionalDatabase,
          source.id,
          sourceCredentialRevision,
        );
        replaceDiscoveredFeedsForRevision(
          transactionalDatabase,
          source.id,
          sourceCredentialRevision,
          availableFeeds,
        );
      }, { behavior: "immediate" });
    } else if (sourceCredentialRevision !== undefined) {
      assertSourceConnectionRevision(
        database,
        source.id,
        sourceCredentialRevision,
      );
    }
    return availableFeeds;
  } finally {
    await handle.dispose?.();
  }
}

export async function subscribeFeed(
  database: Database,
  input: CreateOrReviveFeedInput,
): Promise<PublicFeed> {
  const source = await findSourceById(database, input.sourceId, input.userId);
  if (!source) {
    throw new NotFoundError("source not found");
  }
  if (source.connectorId === ConnectorId.Substack) {
    throw new ConflictError(
      "Substack publications must be added through the Substack connector",
    );
  }
  return await createOrReviveFeed(database, input);
}

export async function unsubscribeFeed(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicFeed> {
  return await softDeleteFeed(database, id, userId);
}
