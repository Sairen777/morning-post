import { bigint, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./user.ts";

/**
 * Infrastructure table (outside the domain-6, intentionally): a server-side
 * authentication session backing an HttpOnly cookie.
 *
 * Only a hash of the cookie token is stored — never the raw token — so a
 * database leak cannot be replayed as a valid cookie. Timestamps are epoch
 * milliseconds stored as `bigint` (mode "number"), honoring the cross-layer
 * epoch-ms boundary rule.
 */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }),
}, (table) => [
  uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
]);

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
