import { bigint, boolean, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import type { EncryptedBlob } from "../../crypto/credential-cipher.ts";
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
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("sources_user_id_connector_id_unique").on(table.userId, table.connectorId),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
