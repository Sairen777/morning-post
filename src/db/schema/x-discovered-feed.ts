import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type { FeedKind } from "../../connectors/connector.types.ts";
import { sources } from "./source.ts";

/**
 * Authorization catalog of X targets returned by the most recent discovery
 * for a source's credential revision. Only targets present here — exactly the
 * group chats and lists the upstream returned — may be subscribed for that
 * connection epoch; `name` and `kind` are the server-canonical values that
 * are persisted on the feed, never client-supplied metadata.
 *
 * Rows are revision-bound: the unique key is source id + credential revision
 * + external id, so a reconnect that bumps `credential_revision` revokes
 * every prior authorization at once and discovery replacement prunes the
 * whole source catalog atomically. Disconnect and account-change reset clear
 * the catalog; old-revision rows left behind by a same-account reconnect are
 * harmless because lookups are exact on the current revision.
 */
export const xDiscoveredFeeds = sqliteTable("x_discovered_feeds",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  credentialRevision: integer("credential_revision").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<FeedKind>().notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("x_discovered_feeds_source_revision_external_unique").on(
    table.sourceId,
    table.credentialRevision,
    table.externalId,
  ),
  check(
    "x_discovered_feeds_kind_check",
    sql`${table.kind} in ('news', 'discussion')`,
  ),
],);

export type XDiscoveredFeedRow = typeof xDiscoveredFeeds.$inferSelect;
export type NewXDiscoveredFeedRow = typeof xDiscoveredFeeds.$inferInsert;
