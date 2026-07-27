import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { EncryptedBlob } from "../../crypto/credential-cipher.ts";
import type { RelevanceFilterOverride } from "../../personalization/personalization.types.ts";
import { users } from "./user.ts";

/**
 * Domain entity: one connector account owned by a user.
 *
 * Credentials are encrypted blobs, nullable so disconnect can revoke credential
 * custody without deleting historical source/feed relationships.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").notNull(),
    credentials: jsonb("credentials").$type<EncryptedBlob | null>(),
    position: integer("position"),
    enabled: boolean("enabled").notNull().default(true),
    showPaidPostTitles: boolean("show_paid_post_titles").notNull().default(
      false,
    ),
    relevanceFilterMode: text("relevance_filter_mode")
      .$type<RelevanceFilterOverride>()
      .notNull()
      .default("inherit"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
