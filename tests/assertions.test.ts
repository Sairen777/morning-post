import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "./assertions.ts";

test("truth and existence assertions narrow without rejecting valid falsy values", () => {
  assert(true);
  assertExists(false);
  assertExists(0);
  assertExists("");
  assertThrows(() => assert(false, "truth context"), Error, "truth context");
  assertThrows(() => assertExists(null), Error, "neither null nor undefined");
  assertThrows(() => assertExists(undefined), Error, "neither null nor undefined");
});

test("deep equality compares structure while strict equality compares identity", () => {
  const left = { values: new Set([1, 2]), nested: { ok: true } };
  const equal = { values: new Set([2, 1]), nested: { ok: true } };
  assertEquals(left, equal);
  assertNotEquals(left, { ...equal, nested: { ok: false } });
  assertStrictEquals(left, left);
  assertThrows(() => assertStrictEquals(left, equal), Error, "strictly equal");
  assertThrows(() => assertStrictEquals(Number.NaN, Number.NaN), Error, "strictly equal");
  assertStrictEquals(-0, 0);
});

test("string inclusion reports the missing substring and actual value", () => {
  assertStringIncludes("morning post", "post");
  const error = assertThrows(
    () => assertStringIncludes("morning post", "night"),
    Error,
    "night",
  );
  assertStringIncludes(error.message, "night");
});

test("assertThrows returns the original error and validates class and message", () => {
  const expected = new TypeError("specific failure text");
  const actual = assertThrows(() => {
    throw expected;
  }, TypeError, "failure text");
  assertStrictEquals(actual, expected);

  assertThrows(
    () => assertThrows(() => {
      throw new Error("wrong text");
    }, TypeError),
    Error,
    "instance of TypeError",
  );
  assertThrows(
    () => assertThrows(() => undefined, Error),
    Error,
    "Expected function to throw",
  );
  assertThrows(() => {
    throw new Error("string overload");
  }, "overload");
});

test("assertRejects returns the original error and validates rejection details", async () => {
  const expected = new RangeError("outside accepted range");
  const actual = await assertRejects(
    () => Promise.reject(expected),
    RangeError,
    "accepted range",
  );
  assertStrictEquals(actual, expected);

  await assertRejects(
    () => assertRejects(() => Promise.resolve(), Error),
    Error,
    "Expected function to reject",
  );
  await assertRejects(
    () => assertRejects(
      () => Promise.reject(new Error("different message")),
      Error,
      "wanted message",
    ),
    Error,
    "wanted message",
  );
  await assertRejects(
    () => Promise.reject(new Error("string overload")),
    "overload",
  );
});
