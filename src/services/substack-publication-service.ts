import {
  type PublicArchivePage,
  readPublicArchive,
} from "../connectors/substack/publication-reader.ts";
import { ConnectorId } from "../constants.ts";
import type { Database } from "../db/client.ts";
import {
  createOrReviveFeed,
  type PublicFeed,
} from "../repositories/feed-repository.ts";
import {
  findSourceByConnectorId,
  type PublicSource,
} from "../repositories/source-repository.ts";
import { ConflictError, ValidationError } from "../server/errors.ts";
import {
  type ConnectorCommit,
  commitImmediately,
} from "./connector-commit.ts";

export type SubstackPublicationProbe = (
  publicationUrl: string,
  signal?: AbortSignal,
) => Promise<PublicArchivePage>;

export interface SubstackPublicationResult {
  source: PublicSource;
  feed: PublicFeed;
}

export class SubstackPublicationService {
  constructor(
    private readonly database: Database,
    private readonly probe: SubstackPublicationProbe = (publicationUrl, signal) =>
      readPublicArchive(publicationUrl, undefined, undefined, undefined, signal),
  ) {}

  async add(
    userId: string,
    publicationUrl: string,
    signal?: AbortSignal,
    commitOperation: ConnectorCommit = commitImmediately,
  ): Promise<SubstackPublicationResult> {
    const source = await findSourceByConnectorId(
      this.database,
      userId,
      ConnectorId.Substack,
    );
    if (!source?.connected) {
      throw new ConflictError("Connect your Substack session first");
    }

    let archive: PublicArchivePage;
    try {
      archive = await this.probe(publicationUrl, signal);
      if (signal?.aborted) {
        throw new Error("Substack publication validation was aborted");
      }
    } catch {
      throw new ValidationError("Substack publication could not be validated");
    }

    const publicationName = archive.items.find((item) => item.publicationName)
      ?.publicationName ?? new URL(archive.origin).hostname;
    const feed = await commitOperation(() =>
      createOrReviveFeed(this.database, {
        userId,
        sourceId: source.id,
        externalId: archive.origin,
        name: publicationName,
        kind: "news",
      })
    );
    return { source, feed };
  }
}
