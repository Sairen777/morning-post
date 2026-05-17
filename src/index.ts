import { Hono } from "@hono/hono";
import { createTelegramClient } from "./connectors/telegram/telegram-client.ts";
import { TelegramConnector } from "./connectors/telegram/telegram-connector.ts";

const app = new Hono();
app.get("/", (c) => c.text("Hello Hono"));

Deno.serve({ port: 3000 }, app.fetch);
console.log("Hono is running at http://localhost:3000");

try {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(new Date().getDate() - 3);

  const tgClient = await createTelegramClient();
  const telegramConnector = new TelegramConnector(tgClient);
  const posts = await telegramConnector.getRawData(threeDaysAgo, new Date());

  console.log(posts);
} catch (error) {
  console.error(error);
}
