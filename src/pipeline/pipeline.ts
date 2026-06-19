import type { Connector } from "../connectors/connector.types.ts";
import type {
  SummarizerService,
  SummaryPoint,
} from "../summarizers/summarizer.types.ts";
import { selectRuleset } from "../summarizers/prompts.ts";

export interface FeedSummary {
  feedExternalId: string;
  summary: SummaryPoint[];
}

export class Pipeline {
  constructor(
    private connector: Connector<unknown>,
    private summarizer: SummarizerService,
  ) {}

  public async run(from: number, to: number): Promise<FeedSummary[]> {
    const normalized = await this.connector.getNormalizedData(from, to);
    await this.writeDebugLog("normalized.json", normalized);

    // One LLM request per source — keeps context focused and avoids topic
    // bleed between sources. Promise.all parallelizes for hosted APIs; a
    // local LLM will serialize on its end.
    const results = await Promise.all(
      Object.entries(normalized).map(async ([feedExternalId, items]) => {
        const rules = selectRuleset(items);
        const startedAt = performance.now();
        const summary = await this.summarizer.summarize(items, rules);
        console.log(
          `${feedExternalId}: ${
            ((performance.now() - startedAt) / 1000).toFixed(1)
          }s (${summary.length} points)`,
        );
        return { feedExternalId, summary };
      }),
    );

    await this.writeDebugLog("summary.json", results);
    return results;
  }

  private async writeDebugLog(name: string, data: unknown): Promise<void> {
    await Deno.mkdir(".debug_logs", { recursive: true });
    await Deno.writeTextFile(
      `.debug_logs/${name}`,
      JSON.stringify(data, null, 2),
    );
  }
}
