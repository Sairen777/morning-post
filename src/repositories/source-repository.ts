import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import {
  type ConnectorCredentials,
  credentialSchemaFor,
} from "../connectors/credential-schemas.ts";
import {
  type CredentialCipher,
  type EncryptedBlob,
} from "../crypto/credential-cipher.ts";
import type { Database } from "../db/client.ts";
import { feeds } from "../db/schema/feed.ts";
import { sources } from "../db/schema/source.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../server/errors.ts";
import { isUniqueViolation } from "../db/errors.ts";

const encryptedBlobSchema = z.object({
  v: z.number(),
  wrappedDataKey: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
});

const publicSourceRowSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  connectorId: z.string(),
  position: z.number().nullable(),
  enabled: z.boolean(),
  showPaidPostTitles: z.boolean(),
  relevanceFilterMode: z.enum(["inherit", "personalized", "include_all"]),
  connected: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const sourceWithCredentialsRowSchema = publicSourceRowSchema.extend({
  credentials: z.unknown().nullable(),
});

export type PublicSource = z.infer<typeof publicSourceRowSchema>;
export type SourceWithCredentials = z.infer<
  typeof sourceWithCredentialsRowSchema
>;

export interface CreateSourceInput {
  userId: string;
  connectorId: string;
  credentials: EncryptedBlob;
  position?: number | null;
  enabled?: boolean;
  relevanceFilterMode?: "inherit" | "personalized" | "include_all";
}

export type UpdateSourceInput = Partial<{
  position: number | null;
  enabled: boolean;
  showPaidPostTitles: boolean;
  relevanceFilterMode: "inherit" | "personalized" | "include_all";
  credentials: EncryptedBlob | null;
}>;

export interface UpsertSourceCredentialsInput {
  userId: string;
  connectorId: string;
  credentials: EncryptedBlob;
}

/** Internal projection: includes credentials so parsePublicSource can compute `connected`. Callers MUST pass through parsePublicSource. */
function selectableColumns() {
  return {
    id: sources.id,
    userId: sources.userId,
    connectorId: sources.connectorId,
    position: sources.position,
    enabled: sources.enabled,
    showPaidPostTitles: sources.showPaidPostTitles,
    relevanceFilterMode: sources.relevanceFilterMode,
    credentials: sources.credentials,
    createdAt: sources.createdAt,
    updatedAt: sources.updatedAt,
  };
}

function parsePublicSource(row: Record<string, unknown>): PublicSource {
  return publicSourceRowSchema.parse({
    ...row,
    connected: row.credentials != null,
  });
}

function parseSourceWithCredentials(
  row: Record<string, unknown>,
): SourceWithCredentials {
  return sourceWithCredentialsRowSchema.parse({
    ...row,
    connected: row.credentials != null,
  });
}

async function findOwnedSourceWithCredentials(
  database: Database,
  id: string,
  userId: string,
): Promise<SourceWithCredentials | null> {
  const rows = await database
    .select(selectableColumns())
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId)))
    .limit(1);
  return rows[0] ? parseSourceWithCredentials(rows[0]) : null;
}

export async function createSource(
  database: Database,
  input: CreateSourceInput,
): Promise<PublicSource> {
  const now = Date.now();
  const credentials = encryptedBlobSchema.parse(input.credentials);

  try {
    const rows = await database
      .insert(sources)
      .values({
        userId: input.userId,
        connectorId: input.connectorId,
        credentials,
        position: input.position ?? null,
        enabled: input.enabled ?? true,
        relevanceFilterMode: input.relevanceFilterMode ?? "inherit",
        createdAt: now,
        updatedAt: now,
      })
      .returning(selectableColumns());
    return parsePublicSource(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("source already exists for connector");
    }
    throw error;
  }
}

export async function listSourcesForUser(
  database: Database,
  userId: string,
): Promise<PublicSource[]> {
  const rows = await database
    .select(selectableColumns())
    .from(sources)
    .where(eq(sources.userId, userId))
    .orderBy(asc(sources.position), asc(sources.createdAt));
  return rows.map(parsePublicSource);
}

export async function findSourceById(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicSource | null> {
  const rows = await database
    .select(selectableColumns())
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.userId, userId)))
    .limit(1);
  return rows[0] ? parsePublicSource(rows[0]) : null;
}

export async function findSourceByConnectorId(
  database: Database,
  userId: string,
  connectorId: string,
): Promise<PublicSource | null> {
  const rows = await database
    .select(selectableColumns())
    .from(sources)
    .where(
      and(eq(sources.userId, userId), eq(sources.connectorId, connectorId)),
    )
    .limit(1);
  return rows[0] ? parsePublicSource(rows[0]) : null;
}

export async function upsertSourceCredentials(
  database: Database,
  input: UpsertSourceCredentialsInput,
): Promise<PublicSource> {
  const now = Date.now();
  const credentials = encryptedBlobSchema.parse(input.credentials);
  const rows = await database
    .insert(sources)
    .values({
      userId: input.userId,
      connectorId: input.connectorId,
      credentials,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sources.userId, sources.connectorId],
      set: {
        credentials,
        enabled: true,
        updatedAt: now,
      },
    })
    .returning(selectableColumns());
  return parsePublicSource(rows[0]);
}

export async function updateSource(
  database: Database,
  id: string,
  userId: string,
  partial: UpdateSourceInput,
): Promise<PublicSource> {
  const updates: UpdateSourceInput & { updatedAt: number } = {
    ...partial,
    updatedAt: Date.now(),
  };
  if (partial.enabled === true && partial.credentials === null) {
    throw new ConflictError(
      "source must be reconnected before it can be enabled",
    );
  }
  if (partial.credentials !== undefined && partial.credentials !== null) {
    updates.credentials = encryptedBlobSchema.parse(partial.credentials);
  }
  if (Object.hasOwn(partial, "showPaidPostTitles")) {
    const existingSource = await findOwnedSourceWithCredentials(
      database,
      id,
      userId,
    );
    if (!existingSource) {
      throw new NotFoundError("source not found");
    }
    if (existingSource.connectorId !== ConnectorId.Substack) {
      throw new ValidationError(
        "showPaidPostTitles is only valid for Substack sources",
      );
    }
  }

  const updatePredicate = partial.enabled === true
    ? and(
      eq(sources.id, id),
      eq(sources.userId, userId),
      isNotNull(sources.credentials),
    )
    : and(eq(sources.id, id), eq(sources.userId, userId));

  try {
    const rows = await database
      .update(sources)
      .set(updates)
      .where(updatePredicate)
      .returning(selectableColumns());
    if (!rows[0]) {
      if (partial.enabled === true) {
        const existingSource = await findOwnedSourceWithCredentials(
          database,
          id,
          userId,
        );
        if (!existingSource) {
          throw new NotFoundError("source not found");
        }
        if (existingSource.credentials === null) {
          throw new ConflictError(
            "source must be reconnected before it can be enabled",
          );
        }
      }
      throw new NotFoundError("source not found");
    }
    return parsePublicSource(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("source already exists for connector");
    }
    throw error;
  }
}

export async function deleteSourceCredentials(
  database: Database,
  id: string,
  userId: string,
): Promise<PublicSource> {
  const now = Date.now();
  return await database.transaction(async (transaction) => {
    const rows = await transaction
      .update(sources)
      .set({ credentials: null, enabled: false, updatedAt: now })
      .where(and(eq(sources.id, id), eq(sources.userId, userId)))
      .returning(selectableColumns());
    if (!rows[0]) {
      throw new NotFoundError("source not found");
    }

    await transaction
      .update(feeds)
      .set({ deletedAt: now, enabled: false, updatedAt: now })
      .where(and(eq(feeds.sourceId, id), isNull(feeds.deletedAt)));

    return parsePublicSource(rows[0]);
  });
}

export async function getDecryptedCredentials(
  database: Database,
  id: string,
  userId: string,
  credentialCipher: CredentialCipher,
): Promise<ConnectorCredentials> {
  const row = await findOwnedSourceWithCredentials(database, id, userId);
  if (!row) {
    throw new NotFoundError("source not found");
  }
  if (!row.credentials) {
    throw new ConflictError("source is disconnected");
  }

  const encryptedBlob = encryptedBlobSchema.safeParse(row.credentials);
  if (!encryptedBlob.success) {
    throw new ValidationError("invalid encrypted source credentials");
  }

  let plaintext: string;
  try {
    plaintext = await credentialCipher.decrypt(encryptedBlob.data, {
      userId: row.userId,
      connectorId: row.connectorId,
    });
  } catch {
    throw new ValidationError("source credentials could not be decrypted");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext);
  } catch {
    throw new ValidationError("source credentials plaintext is not valid JSON");
  }

  const credentialResult = credentialSchemaFor(row.connectorId).safeParse(
    decoded,
  );
  if (!credentialResult.success) {
    throw new ValidationError("invalid source credential shape");
  }
  return credentialResult.data as ConnectorCredentials;
}
