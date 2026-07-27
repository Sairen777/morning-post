export const summarizationModes = ["basic", "thorough"] as const;

export type SummarizationMode = (typeof summarizationModes)[number];
