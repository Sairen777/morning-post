import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
  InterestRuleOrigin,
  InterestRuleState,
} from "../../personalization/personalization.types.ts";
import { users } from "./user.ts";

export const interestRules = sqliteTable("interest_rules",
{
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  normalizedLabel: text("normalized_label").notNull(),
  kind: text("kind").$type<InterestRuleKind>().notNull(),
  disposition: text("disposition").$type<InterestRuleDisposition>().notNull(),
  origin: text("origin").$type<InterestRuleOrigin>().notNull(),
  state: text("state").$type<InterestRuleState>().notNull().default("active"),
  strength: integer("strength").notNull().default(100),
  expiresAt: integer("expires_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
},
(table) => [
  unique("interest_rules_user_kind_label_unique").on(
    table.userId,
    table.kind,
    table.normalizedLabel,
  ),
  index("interest_rules_user_state_idx").on(table.userId, table.state),
  check(
    "interest_rules_kind_check",
    sql`${table.kind} in ('topic', 'entity', 'phrase', 'story_type')`,
  ),
  check(
    "interest_rules_disposition_check",
    sql`${table.disposition} in ('prioritize', 'show_less', 'mute')`,
  ),
  check(
    "interest_rules_origin_check",
    sql`${table.origin} in ('explicit', 'inferred')`,
  ),
  check(
    "interest_rules_state_check",
    sql`${table.state} in ('active', 'dismissed')`,
  ),
  check(
    "interest_rules_strength_check",
    sql`${table.strength} between 0 and 100`,
  ),
  check(
    "interest_rules_mute_origin_check",
    sql`${table.disposition} <> 'mute' or ${table.origin} = 'explicit'`,
  ),
],);

export type InterestRuleRow = typeof interestRules.$inferSelect;
export type NewInterestRuleRow = typeof interestRules.$inferInsert;
