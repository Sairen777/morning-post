import type { AvailableFeed, Connector } from "../connectors/connector.types.ts";
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
import type { createClientFromSession as CreateClientFromSession } from "../connectors/telegram/client-factory.ts";
import type { TelegramConnector as TelegramConnectorClass } from "../connectors/telegram/telegram-connector.ts";

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

  constructor(database: Database, credentialCipher = new CredentialCipher(new EnvMasterKeyProvider())) {
    this.#database = database;
    this.#credentialCipher = credentialCipher;
  }

  async create(source: PublicSource, userId: string): Promise<FeedDiscoveryHandle> {
    if (source.connectorId !== ConnectorId.Telegram) {
      throw new ConflictError("source connector does not support feed discovery");
    }

    const credentials = await getDecryptedCredentials(
      this.#database,
      source.id,
      userId,
      this.#credentialCipher,
    );
    let createClientFromSession: typeof CreateClientFromSession;
    let TelegramConnector: typeof TelegramConnectorClass;
    try {
      // Deliberately lazy: feed discovery loads GramJS only when the discovery endpoint is used.
      ({ createClientFromSession } = await import("../connectors/telegram/client-factory.ts"));
      ({ TelegramConnector } = await import("../connectors/telegram/telegram-connector.ts"));
    } catch (error) {
      throw new Error("Failed to load Telegram feed discovery connector", { cause: error });
    }
    const client = await createClientFromSession(credentials.sessionString);
    return {
      connector: new TelegramConnector(client),
      dispose: async () => await client.disconnect(),
    };
  }
}

export async function discoverFeeds(
  database: Database,
  userId: string,
  sourceId: string,
  discoveryFactory: FeedDiscoveryFactory = new DefaultFeedDiscoveryFactory(database),
): Promise<AvailableFeed[]> {
  const source = await findSourceById(database, sourceId, userId);
  if (!source) {
    throw new NotFoundError("source not found");
  }

  const handle = await discoveryFactory.create(source, userId);
  try {
    if (!handle.connector.listAvailableFeeds) {
      throw new ConflictError("source connector does not support feed discovery");
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
  return await createOrReviveFeed(database, input);
}

export async function unsubscribeFeed(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicFeed> {
  return await softDeleteFeed(database, id, userId);
}
