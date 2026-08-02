import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type { EncryptedBlob } from "../../crypto/credential-cipher.ts";
import type { RelevanceFilterOverride } from "../../personalization/personalization.types.ts";
import { users } from "./user.ts";

/**
 * Domain entity: one connector account owned by a user.
 *
 * Credentials are encrypted blobs, nullable so disconnect can revoke credential
 * custody without deleting historical source/feed relationships.
 */
export const sources = sqliteTable("sources",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectorId: text("connector_id").notNull(),
  credentials: text("credentials", { mode: "json" }).$type<EncryptedBlob | null>(),
  credentialRevision: integer("credential_revision").notNull().default(1),
  position: integer("position"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  showPaidPostTitles: integer("show_paid_post_titles", { mode: "boolean" }).notNull().default(
    false,
  ),
  relevanceFilterMode: text("relevance_filter_mode")
    .$type<RelevanceFilterOverride>()
    .notNull()
    .default("inherit"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("sources_user_id_connector_id_unique").on(
    table.userId,
    table.connectorId,
  ),
  index("sources_user_id_idx").on(table.userId),
  check(
    "sources_connector_id_check",
    sql`${table.connectorId} in ('Telegram', 'Substack', 'YouTube', 'Reddit', 'X', 'RSS')`,
  ),
  check(
    "sources_credentials_disabled_check",
    sql`${table.credentials} is not null or ${table.enabled} = false`,
  ),
  check(
    "sources_relevance_filter_mode_check",
    sql`${table.relevanceFilterMode} in ('inherit', 'personalized', 'include_all')`,
  ),
],);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
