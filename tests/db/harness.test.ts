import { assertEquals, assertRejects } from "@std/assert"
import { sql } from "drizzle-orm";
import { withTestDb } from "../../src/db/testing.ts";

Deno.test("withTestDb — connects and executes a query", async () => {
  await withTestDb(async (database) => {
    const result = await database.execute(sql`select 1 as value`);
    assertEquals(result.length, 1);
    assertEquals(result[0].value, 1);
  });
});

Deno.test("withTestDb — isolation via transaction rollback", async () => {
  // Create a table, insert a row, then the transaction rolls back.
  await withTestDb(async (database) => {
    await database.execute(
      sql`create table _test_isolation (value text)`,
    );
    await database.execute(
      sql`insert into _test_isolation (value) values ('rolled_back')`,
    );
  });

  // In a fresh transaction the table must not exist — proof the first
  // transaction was fully rolled back (including DDL).
  await withTestDb(async (database) => {
    await database.execute(
      sql`create table _test_isolation (value text)`,
    );
    const rows = await database.execute(
      sql`select count(*) as count from _test_isolation`,
    );
    assertEquals(Number(rows[0].count), 0);
  });
});

Deno.test("withTestDb — missing TEST_DATABASE_URL throws", async () => {
  const original = Deno.env.get("TEST_DATABASE_URL");
  Deno.env.delete("TEST_DATABASE_URL");
  try {
    await assertRejects(
      () => withTestDb(async () => {}),
      Error,
      "TEST_DATABASE_URL",
    );
  } finally {
    if (original) Deno.env.set("TEST_DATABASE_URL", original);
  }
});

Deno.test("withTestDb — failing test body still rolls back", async () => {
  try {
    await withTestDb(async (database) => {
      await database.execute(
        sql`create table _test_iso_fail (value text)`,
      );
      await database.execute(
        sql`insert into _test_iso_fail (value) values ('should_rollback')`,
      );
      throw new Error("simulated test failure");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "simulated test failure") {
      throw error;
    }
  }

  // Table must not exist — the failed transaction was rolled back.
  await withTestDb(async (database) => {
    await database.execute(
      sql`create table _test_iso_fail (value text)`,
    );
    const rows = await database.execute(
      sql`select count(*) as count from _test_iso_fail`,
    );
    assertEquals(Number(rows[0].count), 0);
  });
});
