/**
 * Runs an interactive human-graded dialogue summarization eval against a
 * captured sample file and appends the result to a local Markdown history.
 *
 * Run via: deno task eval -- --sample <path> [--user-id <uuid>] [--feed-id <uuid>] [--results <path>]
 */
import {
  parseDialogueSample,
  summarizeDialogueSample,
  renderSummaryForTerminal,
  collectHumanGrade,
  createDialogueEvalRecord,
  appendDialogueEvalRecord,
} from "../../src/evals/dialogue-eval.ts";
import { database } from "../../src/db/client.ts";

export interface RunDialogueEvalArgs {
  samplePath: string;
  userId: string | null;
  feedId: string | null;
  resultsPath: string;
}

export function parseRunDialogueEvalArgs(args: string[]): RunDialogueEvalArgs {
  const result: RunDialogueEvalArgs = {
    samplePath: "",
    userId: null,
    feedId: null,
    resultsPath: "eval-results/dialogues/evaluations.md",
  };

  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    if (!flag.startsWith("--")) {
      throw new Error(`unknown option: ${flag}`);
    }

    if (flag === "--") {
      i++;
      continue;
    }

    if (flag === "--sample") {
      i++;
      if (i >= args.length || args[i].startsWith("--")) {
        throw new Error("missing required option: --sample");
      }
      result.samplePath = args[i];
      i++;
      continue;
    }

    if (flag === "--user-id") {
      i++;
      if (i >= args.length || args[i].startsWith("--")) {
        throw new Error("missing required option: --user-id");
      }
      result.userId = args[i];
      i++;
      continue;
    }

    if (flag === "--feed-id") {
      i++;
      if (i >= args.length || args[i].startsWith("--")) {
        throw new Error("missing required option: --feed-id");
      }
      result.feedId = args[i];
      i++;
      continue;
    }

    if (flag === "--results") {
      i++;
      if (i >= args.length || args[i].startsWith("--")) {
        throw new Error(`missing required option: --results`);
      }
      result.resultsPath = args[i];
      i++;
      continue;
    }

    throw new Error(`unknown option: ${flag}`);
  }

  if (!result.samplePath) {
    throw new Error("missing required option: --sample");
  }

  return result;
}

if (import.meta.main) {
  const args = parseRunDialogueEvalArgs(Deno.args);

  const raw = await Deno.readTextFile(args.samplePath);
  const sample = parseDialogueSample(JSON.parse(raw));

  const result = await summarizeDialogueSample({
    database,
    sample,
    userId: args.userId ?? undefined,
    feedId: args.feedId ?? undefined,
  });

  console.log(renderSummaryForTerminal(result));

  const grade = collectHumanGrade((message) => prompt(message));

  const record = await createDialogueEvalRecord({ sample, result, grade });

  await appendDialogueEvalRecord(args.resultsPath, record);

  console.log(`Saved dialogue eval to ${args.resultsPath}`);
  Deno.exit(0);
}
