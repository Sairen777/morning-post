import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";
import type { IConnectorNormalizedData } from "./connectors/connector.types.ts";
import { OpenAICompatibleSummarizerService } from "./summarizer/openai-compatible-summarizer.ts";
import type {
  NormalizedItem,
  SummaryPoint,
} from "./summarizer/summarizer.types.ts";

const app = new Hono();
app.get("/", (c) => c.text("Hello Hono"));

Deno.serve({ port: 3000 }, app.fetch);
console.log("Hono is running at http://localhost:3000");

function toNormalizedItems(data: IConnectorNormalizedData): NormalizedItem[] {
  const items: NormalizedItem[] = [];
  for (const [channelName, messages] of Object.entries(data)) {
    for (const msg of messages) {
      items.push({
        connectorId: "telegram",
        sourceId: channelName,
        date: new Date(msg.timestamp),
        title: null,
        text: msg.text,
        author: msg.author,
        url: msg.url ?? null,
        media: msg.media,
        isGroup: msg.isGroup ?? false,
      });
    }
  }
  return items;
}

function printSummary(summary: SummaryPoint[]): void {
  for (const point of summary) {
    console.log(`• ${point.text}`);
    if (point.channel || point.sourceUrl) {
      const meta = [point.channel, point.date, point.sourceUrl]
        .filter(Boolean)
        .join(" · ");
      console.log(`  ${meta}`);
    }
  }
}

try {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(new Date().getDate() - 2);

  const tgClient = await createTelegramClient();
  const telegramConnector = new TelegramConnector(tgClient);
  const normalized = await telegramConnector.getNormalizedData(
    threeDaysAgo,
    new Date(),
  );
  const items = toNormalizedItems(normalized);

  const channelItems = items.filter((i) => !i.isGroup);
  const groupItems = items.filter((i) => i.isGroup);

  console.log(
    `Fetched ${items.length} messages (${channelItems.length} channel, ${groupItems.length} group). Summarizing...`,
  );

  const summarizer = new OpenAICompatibleSummarizerService();

  if (channelItems.length > 0) {
    const t0 = performance.now();
    const summary = await summarizer.summarize(channelItems, {
      format: "bullet points",
    });
    console.log(
      `Channel summarization took ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );
    await Deno.writeTextFile(
      "channel_summary.json",
      JSON.stringify(summary, null, 2),
    );
    console.log("\n=== Channel Summary ===\n");
    printSummary(summary);
  }

  if (groupItems.length > 0) {
    const t0 = performance.now();
    const groupSummary = await summarizer.summarize(groupItems, {
      mode: "discussion",
    });
    console.log(
      `Group summarization took ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );
    await Deno.writeTextFile(
      "group_summary.json",
      JSON.stringify(groupSummary, null, 2),
    );
    console.log("\n=== Group Summary ===\n");
    printSummary(groupSummary);
  }

  // await Deno.remove("media", { recursive: true });
} catch (error) {
  console.error(error);
}
