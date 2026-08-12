import type {
  RelevanceFilterMode,
  RelevanceFilterOverride,
} from "./personalization.types.ts";

/**
 * Distinct whole-story `not_relevant` feedback events attributed to a warming
 * source that graduate it to ordinary inherited personalization.
 */
export const SOURCE_RELEVANCE_WARMUP_NEGATIVE_THRESHOLD = 2;

/**
 * Resolves the effective filter mode from the most-specific configured value:
 * explicit feed override, explicit source override, then an active source
 * warmup window (include-all while muting still applies), then the user
 * default.
 */
export function resolveEffectiveRelevanceFilterMode(
  userDefault: RelevanceFilterMode,
  sourceOverride: RelevanceFilterOverride,
  feedOverride: RelevanceFilterOverride,
  relevanceWarmup = false,
): RelevanceFilterMode {
  if (feedOverride !== "inherit") {
    return feedOverride;
  }
  if (sourceOverride !== "inherit") {
    return sourceOverride;
  }
  if (relevanceWarmup) {
    return "include_all";
  }
  return userDefault;
}
