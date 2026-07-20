import { and, asc, between, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/item.ts";
import type { NormalizedItem } from "../connectors/connector.types.ts";

const mediaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("photo"), localPath: z.string() }),
  z.object({ type: z.literal("album"), localPaths: z.array(z.string()) }),
  z.object({ type: z.literal("video") }),
  z.object({ type: z.literal("document"), mimeType: z.string() }),
  z.object({ type: z.literal("webpage"), url: z.string() }),
]);

export const normalizedItemSchema = z.object({
  connectorId: z.nativeEnum(ConnectorId),
  feedExternalId: z.string().min(1),
  externalId: z.string().min(1),
  date: z.number(),
  title: z.string().nullable(),
  text: z.string(),
  author: z.string().nullable(),
  url: z.string().nullable(),
  media: mediaSchema.optional(),
  meta: z.record(z.unknown()).optional(),
});

const storedItemRowSchema = z.object({
  id: z.string().uuid(),
  feedId: z.string().uuid(),
  externalId: z.string(),
  date: z.number(),
  payload: normalizedItemSchema,
  fetchedAt: z.number(),
});

export type StoredItem = z.infer<typeof storedItemRowSchema>;

function parseStoredItem(row: unknown): StoredItem {
  return storedItemRowSchema.parse(row);
}

export function validateNormalizedItems(
  normalizedItems: NormalizedItem[],
): NormalizedItem[] {
  return normalizedItems.map((item) => normalizedItemSchema.parse(item));
}

export async function upsertItems(
  database: Database,
  feedId: string,
  normalizedItems: NormalizedItem[],
  fetchedAt = Date.now(),
): Promise<StoredItem[]> {
  const validItems = validateNormalizedItems(normalizedItems);
  if (validItems.length === 0) {
    return [];
  }

  const rows = await database
    .insert(items)
    .values(validItems.map((item) => ({
      feedId,
      externalId: item.externalId,
      date: item.date,
      payload: item,
      fetchedAt,
    })))
    .onConflictDoUpdate({
      target: [items.feedId, items.externalId],
      set: {
        date: sql`excluded.date`,
        payload: sql`excluded.payload`,
        fetchedAt:
          sql`case when ${items.payload} is distinct from excluded.payload then excluded.fetched_at else ${items.fetchedAt} end`,
      },
    })
    .returning();

  return rows.map(parseStoredItem);
}

export async function listMediaPathsForFeedWindow(
  database: Database,
  feedId: string,
  from: number,
  to: number,
): Promise<string[]> {
  const rows = await database
    .select()
    .from(items)
    .where(and(eq(items.feedId, feedId), between(items.date, from, to)))
    .orderBy(asc(items.date), asc(items.externalId));
  const paths: string[] = [];
  for (const row of rows) {
    const payload = row.payload as NormalizedItem;
    if (payload.media?.type === "photo") {
      paths.push(payload.media.localPath);
    } else if (payload.media?.type === "album") {
      paths.push(...payload.media.localPaths);
    }
  }
  return paths;
}
export async function listFeedIdsWithPaidItems(
  database: Database,
  feedIds: string[],
  from: number,
  to: number,
): Promise<string[]> {
  if (feedIds.length === 0) {
    return [];
  }
  const rows = await database
    .selectDistinct({ feedId: items.feedId })
    .from(items)
    .where(and(
      inArray(items.feedId, feedIds),
      between(items.date, from, to),
      sql`${items.payload}->>'connectorId' = ${ConnectorId.Substack}`,
      sql`${items.payload}->'meta'->>'audience' = 'only_paid'`,
    ))
    .orderBy(asc(items.feedId));
  return rows.map((row) => row.feedId);
}

export async function listItemsForFeedsInWindow(
  database: Database,
  feedIds: string[],
  from: number,
  to: number,
): Promise<StoredItem[]> {
  if (feedIds.length === 0) {
    return [];
  }
  const rows = await database
    .select()
    .from(items)
    .where(and(inArray(items.feedId, feedIds), between(items.date, from, to)))
    .orderBy(asc(items.date), asc(items.externalId));
  return rows.map(parseStoredItem);
}

export async function listItemsForFeedInWindow(
  database: Database,
  feedId: string,
  from: number,
  to: number,
): Promise<StoredItem[]> {
  const rows = await database
    .select()
    .from(items)
    .where(and(eq(items.feedId, feedId), between(items.date, from, to)))
    .orderBy(asc(items.date), asc(items.externalId));
  return rows.map(parseStoredItem);
}
