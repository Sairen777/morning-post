/**
 * Captures a Telegram discussion for a time period and saves it as a local
 * dialogue sample JSON file for later eval runs.
 *
 * Run via: deno task eval:capture-dialogue -- --user-id <uuid> --source-id <uuid> --feed-id <uuid> --from <ISO> --to <ISO> --slug <name> [--force]
 */
import { parseEpochMs, safeSlug, captureDialogueSample } from "../../src/evals/dialogue-eval.ts";
import { database } from "../../src/db/client.ts";

export interface CaptureDialogueArgs {
  userId: string;
  sourceId: string;
  feedId: string;
  fromMs: number;
  toMs: number;
  slug: string;
  force: boolean;
}

export function parseCaptureDialogueArgs(args: string[]): CaptureDialogueArgs {
  const seen = new Map<string, string | boolean>();
  const required = new Set([
    "--user-id",
    "--source-id",
    "--feed-id",
    "--from",
    "--to",
    "--slug",
  ]);

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

    if (flag === "--force") {
      seen.set(flag, true);
      i++;
      continue;
    }

    if (
      flag === "--user-id" ||
      flag === "--source-id" ||
      flag === "--feed-id" ||
      flag === "--from" ||
      flag === "--to" ||
      flag === "--slug"
    ) {
      i++;
      if (i >= args.length || args[i].startsWith("--")) {
        throw new Error(`missing required option: ${flag}`);
      }
      seen.set(flag, args[i]);
      i++;
      continue;
    }

    throw new Error(`unknown option: ${flag}`);
  }

  for (const req of required) {
    if (!seen.has(req)) {
      throw new Error(`missing required option: ${req}`);
    }
  }

  return {
    userId: seen.get("--user-id") as string,
    sourceId: seen.get("--source-id") as string,
    feedId: seen.get("--feed-id") as string,
    fromMs: parseEpochMs(seen.get("--from") as string),
    toMs: parseEpochMs(seen.get("--to") as string),
    slug: safeSlug(seen.get("--slug") as string),
    force: seen.get("--force") === true,
  };
}

if (import.meta.main) {
  const args = parseCaptureDialogueArgs(Deno.args);

  const sample = await captureDialogueSample({
    database,
    userId: args.userId,
    sourceId: args.sourceId,
    feedId: args.feedId,
    fromMs: args.fromMs,
    toMs: args.toMs,
  });

  const outDir = `eval-data/dialogues`;
  const outPath = `${outDir}/${args.slug}.json`;

  try {
    await Deno.stat(outPath);
    if (!args.force) {
      throw new Error(`output already exists: ${outPath}`);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(outPath, JSON.stringify(sample, null, 2));

  console.log(`Saved ${sample.itemCount} dialogue items to ${outPath}`);
  Deno.exit(0);
}
