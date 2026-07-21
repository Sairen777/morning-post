import type {
  AvailableFeed,
  Connector,
} from "../connectors/connector.types.ts";
import { telegramCredentialSchema } from "../connectors/credential-schemas.ts";
import {
  type createClientFromSession as CreateClientFromSession,
  destroyTelegramClient,
} from "../connectors/telegram/client-factory.ts";
import type { TelegramConnector as TelegramConnectorClass } from "../connectors/telegram/telegram-connector.ts";
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
  findSourceById,
  getDecryptedCredentials,
  type PublicSource,
} from "../repositories/source-repository.ts";
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

export interface FeedDiscoveryHandle {
  connector: Pick<Connector<unknown>, "listAvailableFeeds">;
  dispose?(): Promise<void> | void;
}

export interface FeedDiscoveryFactory {
  create(source: PublicSource, userId: string): Promise<FeedDiscoveryHandle>;
}

export class DefaultFeedDiscoveryFactory implements FeedDiscoveryFactory {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #runtimeLoader: TelegramFeedDiscoveryRuntimeLoader;

  constructor(
    database: Database,
    credentialCipher = new CredentialCipher(new EnvMasterKeyProvider()),
    runtimeLoader: TelegramFeedDiscoveryRuntimeLoader =
      loadTelegramFeedDiscoveryRuntime,
  ) {
    this.#database = database;
    this.#credentialCipher = credentialCipher;
    this.#runtimeLoader = runtimeLoader;
  }

  async create(
    source: PublicSource,
    userId: string,
  ): Promise<FeedDiscoveryHandle> {
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
}

export async function discoverFeeds(
  database: Database,
  userId: string,
  sourceId: string,
  discoveryFactory: FeedDiscoveryFactory = new DefaultFeedDiscoveryFactory(
    database,
  ),
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
    return await handle.connector.listAvailableFeeds();
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
