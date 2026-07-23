export const relevanceFilterModes = ["personalized", "include_all"] as const;
export type RelevanceFilterMode = (typeof relevanceFilterModes)[number];

export const relevanceFilterOverrides = [
  "inherit",
  ...relevanceFilterModes,
] as const;
export type RelevanceFilterOverride =
  (typeof relevanceFilterOverrides)[number];

export const interestRuleKinds = [
  "topic",
  "entity",
  "phrase",
  "story_type",
] as const;
export type InterestRuleKind = (typeof interestRuleKinds)[number];

export const interestRuleDispositions = [
  "prioritize",
  "show_less",
  "mute",
] as const;
export type InterestRuleDisposition =
  (typeof interestRuleDispositions)[number];

export const interestRuleOrigins = ["explicit", "inferred"] as const;
export type InterestRuleOrigin = (typeof interestRuleOrigins)[number];

export const interestRuleStates = ["active", "dismissed"] as const;
export type InterestRuleState = (typeof interestRuleStates)[number];
