import type {
  RelevanceFilterMode,
  RelevanceFilterOverride,
} from "./personalization.types.ts";

/** Resolves the effective filter mode from the most-specific configured value. */
export function resolveEffectiveRelevanceFilterMode(
  userDefault: RelevanceFilterMode,
  sourceOverride: RelevanceFilterOverride,
  feedOverride: RelevanceFilterOverride,
): RelevanceFilterMode {
  if (feedOverride !== "inherit") {
    return feedOverride;
  }
  if (sourceOverride !== "inherit") {
    return sourceOverride;
  }
  return userDefault;
}
