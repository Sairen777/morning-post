import type { AvailableFeed } from "../connectors/connector.types.ts";
import {
  type SubstackCredentials,
  substackCredentialSchema,
} from "../connectors/credential-schemas.ts";
import { normalizePublicationUrl } from "../connectors/substack/publication-reader.ts";
import {
  SubstackSessionClient,
  SubstackSessionExpiredError,
  type SubstackSubscriptionPublication,
} from "../connectors/substack/session-client.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import { EnvMasterKeyProvider } from "../crypto/key-provider.ts";
import type { Database } from "../db/client.ts";
import {
  findSourceByConnectorId,
  getDecryptedCredentials,
} from "../repositories/source-repository.ts";
import { ConflictError, ValidationError } from "../server/errors.ts";

export interface SubstackPublicationDiscoveryClient {
  validateSession(signal?: AbortSignal): Promise<{ userId: number }>;
  listSubscribedPublications(
    signal?: AbortSignal,
  ): Promise<SubstackSubscriptionPublication[]>;
}

export interface SubstackPublicationDiscoveryClientFactory {
  create(credentials: SubstackCredentials): SubstackPublicationDiscoveryClient;
}

const defaultClientFactory: SubstackPublicationDiscoveryClientFactory = {
  create: (credentials) => new SubstackSessionClient(credentials),
};

export class SubstackPublicationDiscoveryService {
  constructor(
    private readonly database: Database,
    private readonly clientFactory: SubstackPublicationDiscoveryClientFactory =
      defaultClientFactory,
    private readonly credentialCipher = new CredentialCipher(
      new EnvMasterKeyProvider(),
    ),
  ) {}

  async list(userId: string, signal?: AbortSignal): Promise<AvailableFeed[]> {
    const source = await findSourceByConnectorId(
      this.database,
      userId,
      ConnectorId.Substack,
    );
    if (!source?.connected) {
      throw new ConflictError("Connect your Substack session first");
    }

    const credentials = substackCredentialSchema.parse(
      await getDecryptedCredentials(
        this.database,
        source.id,
        userId,
        this.credentialCipher,
      ),
    );
    const client = this.clientFactory.create(credentials);
    try {
      await client.validateSession(signal);
    } catch (error) {
      if (error instanceof SubstackSessionExpiredError) {
        throw new ValidationError("Substack session is invalid or expired");
      }
      throw error;
    }

    let publications: SubstackSubscriptionPublication[];
    try {
      publications = await client.listSubscribedPublications(signal);
    } catch (error) {
      if (error instanceof SubstackSessionExpiredError) {
        throw new ValidationError("Substack session is invalid or expired");
      }
      throw error;
    }

    const feeds: AvailableFeed[] = [];
    const seenPublicationIds = new Set<number>();
    for (const publication of publications) {
      if (seenPublicationIds.has(publication.id)) continue;
      seenPublicationIds.add(publication.id);

      let origin: string | undefined;
      if (publication.customDomain) {
        try {
          origin = normalizePublicationUrl(publication.customDomain);
        } catch {
          // A malformed custom domain does not invalidate a usable Substack subdomain.
        }
      }
      if (!origin && isValidSubdomain(publication.subdomain)) {
        try {
          origin = normalizePublicationUrl(
            `${publication.subdomain}.substack.com`,
          );
        } catch {
          origin = undefined;
        }
      }
      if (!origin) continue;

      const trimmedName = publication.name?.trim();
      feeds.push({
        externalId: origin,
        name: trimmedName || new URL(origin).hostname,
        kind: "news",
      });
    }
    return feeds;
  }
}

function isValidSubdomain(value: string | null): value is string {
  return value !== null &&
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(value);
}
