export const sourceSummarizationModes = ["basic", "thorough"] as const;

export type SourceSummarizationMode =
  (typeof sourceSummarizationModes)[number];
