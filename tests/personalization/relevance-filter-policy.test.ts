import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import { resolveEffectiveRelevanceFilterMode } from "../../src/personalization/relevance-filter-policy.ts";

test("effective relevance mode uses feed then source then user precedence", () => {
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "include_all", "personalized"),
    "personalized",
  );
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "include_all", "inherit"),
    "include_all",
  );
  assertEquals(
    resolveEffectiveRelevanceFilterMode("include_all", "inherit", "inherit"),
    "include_all",
  );
});
