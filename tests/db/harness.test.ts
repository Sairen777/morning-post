import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { sql } from "drizzle-orm";
import { withTestDb } from "../../src/db/testing.ts";

test("withTestDb — connects and executes a query", async () => {
  await withTestDb(async (database) => {
    const result = database.all<{ value: number }>(sql`select 1 as value`);
    assertEquals(result.length, 1);
    assertEquals(result[0].value, 1);
  });
});

test("withTestDb — isolates calls with fresh databases", async () => {
  await withTestDb(async (database) => {
    database.run(sql`create table _test_isolation (value text)`);
    database.run(
      sql`insert into _test_isolation (value) values ('first database')`,
    );
  });

  await withTestDb(async (database) => {
    database.run(sql`create table _test_isolation (value text)`);
    const rows = database.all<{ count: number }>(
      sql`select count(*) as count from _test_isolation`,
    );
    assertEquals(Number(rows[0]?.count), 0);
  });
});

test("withTestDb — closes a failed callback's isolated database", async () => {
  let callbackError: unknown;
  try {
    await withTestDb(async (database) => {
      database.run(sql`create table _test_iso_fail (value text)`);
      throw new Error("simulated test failure");
    });
  } catch (error) {
    callbackError = error;
  }
  assertEquals(
    callbackError instanceof Error ? callbackError.message : undefined,
    "simulated test failure",
  );

  await withTestDb(async (database) => {
    database.run(sql`create table _test_iso_fail (value text)`);
    const rows = database.all<{ count: number }>(
      sql`select count(*) as count from _test_iso_fail`,
    );
    assertEquals(Number(rows[0]?.count), 0);
  });
});
