import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";
import type { IConnectorNormalizedData } from "./connectors/connector.types.ts";
import { OpenAICompatibleSummarizerService } from "./summarizer/openai-compatible-summarizer.ts";
import type { NormalizedItem } from "./summarizer/summarizer.types.ts";

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
        url: null,
        media: msg.media,
      });
    }
  }
  return items;
}

try {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(new Date().getDate() - 5);

  const tgClient = await createTelegramClient();
  const telegramConnector = new TelegramConnector(tgClient);
  const normalized = await telegramConnector.getNormalizedData(
    threeDaysAgo,
    new Date(),
  );
  const items = toNormalizedItems(normalized);

  console.log(`Fetched ${items.length} messages. Summarizing...`);

  await Deno.writeTextFile("items.json", JSON.stringify(items, null, 2));

  const summarizer = new OpenAICompatibleSummarizerService();
  const t0 = performance.now();
  const summary = await summarizer.summarize(items, {
    language: "English",
    format: "bullet points",
  });
  console.log(
    `Summarization took ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  console.log("\n=== Summary ===\n");
  console.log(summary);

  await Deno.remove("media", { recursive: true });
} catch (error) {
  console.error(error);
}
