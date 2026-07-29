export const STORY_DETAIL_LEVELS = [
  "headlines",
  "balanced",
  "thorough",
] as const;

export type StoryDetailLevel = (typeof STORY_DETAIL_LEVELS)[number];

export const DEFAULT_STORY_DETAIL_LEVEL: StoryDetailLevel = "balanced";
