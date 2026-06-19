import { bigint, index, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Domain entity: a person who owns sources, feeds, and digests.
 *
 * Timestamps are epoch milliseconds stored as `bigint` (mode "number"), never
 * `timestamptz`, to honor the cross-layer epoch-ms boundary rule.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  defaultLanguage: text("default_language"),
  defaultModel: text("default_model"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("users_created_at_id_idx").on(table.createdAt, table.id),
]);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
