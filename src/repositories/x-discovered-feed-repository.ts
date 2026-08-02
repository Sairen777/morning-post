import { and, asc, eq } from "drizzle-orm";
import type { AvailableFeed, FeedKind } from "../connectors/connector.types.ts";
import type { Database } from "../db/client.ts";
import { xDiscoveredFeeds } from "../db/schema/x-discovered-feed.ts";

/** Server-canonical catalog entry for one X target. */
export interface CatalogedXTarget {
  externalId: string;
  name: string;
  kind: FeedKind;
}

export interface XDiscoveredFeedRecord extends CatalogedXTarget {
  credentialRevision: number;
}

/**
 * Atomically replaces the source's whole discovery catalog (every revision)
 * with exactly `feeds`, bound to `credentialRevision`. Must run inside the
 * same immediate transaction that revalidated the source's current credential
 * revision: the write lock then guarantees no concurrently committed revision
 * bump or reset can slip between the revalidation and the replace, and stale
 * revisions are pruned at the same time.
 */
export function replaceDiscoveredFeedsForRevision(
  database: Database,
  sourceId: string,
  credentialRevision: number,
  feeds: AvailableFeed[],
): void {
  database.delete(xDiscoveredFeeds)
    .where(eq(xDiscoveredFeeds.sourceId, sourceId))
    .run();
  if (feeds.length === 0) {
    return;
  }
  const now = Date.now();
  database.insert(xDiscoveredFeeds)
    .values(feeds.map((feed) => ({
      sourceId,
      credentialRevision,
      externalId: feed.externalId,
      name: feed.name,
      kind: feed.kind,
      createdAt: now,
    })))
    .run();
}

/**
 * Exact revision-bound lookup: the only subscription authorization for X
 * targets. A row from any other revision does not authorize the target.
 */
export function findDiscoveredFeedForRevision(
  database: Database,
  sourceId: string,
  credentialRevision: number,
  externalId: string,
): CatalogedXTarget | null {
  const row = database
    .select({
      externalId: xDiscoveredFeeds.externalId,
      name: xDiscoveredFeeds.name,
      kind: xDiscoveredFeeds.kind,
    })
    .from(xDiscoveredFeeds)
    .where(and(
      eq(xDiscoveredFeeds.sourceId, sourceId),
      eq(xDiscoveredFeeds.credentialRevision, credentialRevision),
      eq(xDiscoveredFeeds.externalId, externalId),
    ))
    .limit(1)
    .get();
  return row ?? null;
}

/** Removes every catalog row for a source (all revisions). */
export function clearDiscoveredFeedsForSource(
  database: Database,
  sourceId: string,
): void {
  database.delete(xDiscoveredFeeds)
    .where(eq(xDiscoveredFeeds.sourceId, sourceId))
    .run();
}

/** Full catalog contents for a source, for tests and diagnostics. */
export function listDiscoveredFeedsForSource(
  database: Database,
  sourceId: string,
): XDiscoveredFeedRecord[] {
  return database
    .select({
      credentialRevision: xDiscoveredFeeds.credentialRevision,
      externalId: xDiscoveredFeeds.externalId,
      name: xDiscoveredFeeds.name,
      kind: xDiscoveredFeeds.kind,
    })
    .from(xDiscoveredFeeds)
    .where(eq(xDiscoveredFeeds.sourceId, sourceId))
    .orderBy(
      asc(xDiscoveredFeeds.credentialRevision),
      asc(xDiscoveredFeeds.externalId),
    )
    .all();
}
