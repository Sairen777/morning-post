import { throwIfAborted } from "../connectors/x/abort.ts";
import {
  formatXFeedExternalId,
  formatXTargetUrl,
  MAX_X_FEEDS,
  parseXTargetUrl,
  type XTarget,
} from "../connectors/x/index.ts";
import type { AvailableFeed } from "../connectors/connector.types.ts";
import { xCredentialSchema } from "../connectors/credential-schemas.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import type { Database } from "../db/client.ts";
import {
  createOrReviveFeed,
  type PublicFeed,
} from "../repositories/feed-repository.ts";
import {
  findSourceById,
  getDecryptedCredentials,
} from "../repositories/source-repository.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../server/errors.ts";
import {
  type ConnectorCommit,
  commitImmediately,
} from "./connector-commit.ts";

export interface XTargetBrowserRuntime {
  resolveTarget(
    profileId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<AvailableFeed>;
}

export interface XTargetServiceDependencies {
  database: Database;
  credentialCipher: CredentialCipher;
  browserRuntime: XTargetBrowserRuntime;
}


export class XTargetService {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #browserRuntime: XTargetBrowserRuntime;

  constructor(dependencies: XTargetServiceDependencies) {
    this.#database = dependencies.database;
    this.#credentialCipher = dependencies.credentialCipher;
    this.#browserRuntime = dependencies.browserRuntime;
  }

  async add(
    userId: string,
    sourceId: string,
    url: string,
    signal?: AbortSignal,
    commitOperation: ConnectorCommit = commitImmediately,
  ): Promise<PublicFeed> {
    const source = await findSourceById(this.#database, sourceId, userId);
    if (!source) throw new NotFoundError("source not found");
    if (source.connectorId !== ConnectorId.X) {
      throw new ConflictError("source is not an X connector");
    }

    let target: XTarget;
    try {
      target = parseXTargetUrl(url);
    } catch {
      throw new ValidationError("invalid X target URL");
    }
    const credentials = xCredentialSchema.parse(
      await getDecryptedCredentials(
        this.#database,
        source.id,
        userId,
        this.#credentialCipher,
      ),
    );
    if (credentials.profileId !== userId) {
      throw new ValidationError("invalid X browser profile credentials");
    }

    const feed = await this.#browserRuntime.resolveTarget(
      credentials.profileId,
      formatXTargetUrl(target),
      signal,
    );
    if (
      feed.externalId !== formatXFeedExternalId(target) ||
      feed.kind !== (target.kind === "chat" ? "discussion" : "news") ||
      feed.name.trim() === ""
    ) {
      throw new ValidationError("X target did not resolve to the requested feed");
    }
    throwIfAborted(signal);
    return await commitOperation(() =>
      createOrReviveFeed(this.#database, {
        userId,
        sourceId: source.id,
        externalId: feed.externalId,
        name: feed.name,
        kind: feed.kind,
      }, { maxActiveFeeds: MAX_X_FEEDS })
    );
  }
}
