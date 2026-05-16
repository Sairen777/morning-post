import { Elysia } from "elysia";
import { createTelegramClient } from "./connectors/telegram/telegram-client";
import { TelegramConnector } from "./connectors/telegram/telegram-connector";

const app = new Elysia().get("/", () => "Hello Elysia").listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

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
