import type { FeedKind } from "../connectors/connector.types.ts";
import { DEFAULT_SYSTEM_PROMPT, buildDiscussionPrompt, buildNewsPrompt } from "./prompts.ts";
import type { SummaryRuleset } from "./summarizer.types.ts";

export interface ComposeSummaryRulesetInput {
  kind: FeedKind;
  systemPrompt: string;
  customPrompt?: string | null;
  language?: string | null;
}

function baseRuleset(kind: FeedKind, language?: string | null): SummaryRuleset {
  const options = language === undefined || language === null || language === ""
    ? undefined
    : { language };
  return kind === "discussion"
    ? buildDiscussionPrompt(options)
    : buildNewsPrompt(options);
}

export function composeSummaryRuleset(input: ComposeSummaryRulesetInput): SummaryRuleset {
  const kindRuleset = baseRuleset(input.kind, input.language);
  const systemPromptLayers = [
    DEFAULT_SYSTEM_PROMPT,
    input.systemPrompt.trim(),
    input.customPrompt?.trim() || null,
    kindRuleset.systemPrompt,
  ].filter((layer): layer is string => layer !== null && layer.length > 0);

  return {
    ...kindRuleset,
    systemPrompt: systemPromptLayers.join("\n\n"),
  };
}
