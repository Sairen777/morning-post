import { test } from "bun:test";
import { assertEquals } from "../assertions.ts";
import {
  SOURCE_RELEVANCE_WARMUP_NEGATIVE_THRESHOLD,
  resolveEffectiveRelevanceFilterMode,
} from "../../src/personalization/relevance-filter-policy.ts";

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

test("active source warmup resolves to include-all only when both overrides inherit", () => {
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "inherit", "inherit", true),
    "include_all",
  );
  // Explicit feed override retains precedence over warmup.
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "inherit", "personalized", true),
    "personalized",
  );
  // Explicit source override retains precedence over warmup.
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "include_all", "inherit", true),
    "include_all",
  );
  // Inactive warmup falls through to the user default.
  assertEquals(
    resolveEffectiveRelevanceFilterMode("personalized", "inherit", "inherit", false),
    "personalized",
  );
});

test("warmup graduates after two distinct negative feedback events", () => {
  assertEquals(SOURCE_RELEVANCE_WARMUP_NEGATIVE_THRESHOLD, 2);
});
