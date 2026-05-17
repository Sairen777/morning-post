import { TelegramClient } from "npm:telegram@^2.26.22";
import { Api } from "npm:telegram@^2.26.22";
import type { IConnector, IConnectorNormalizedData } from "../connector.types.ts";
import type { ChannelInfo, ChannelMessage } from "./telegram-connector.types.ts";

type TelegramRawData = Record<string, ChannelMessage[]>;

export class TelegramConnector implements IConnector<TelegramRawData> {
  constructor(private client: TelegramClient) {}

  public async getRawData(from: Date, to: Date): Promise<TelegramRawData> {
    const result: TelegramRawData = {};
    const fromUnix = Math.floor(from.getTime() / 1000);

    for await (const dialog of this.client.iterDialogs({})) {
      if ((dialog.message?.date ?? 0) < fromUnix) continue;

      const entity = dialog.entity;
      if (!entity) continue;

      const title = dialog.title ?? entity.id.toString();
      const messages = await this.getMessages(entity, from, to);

      if (messages.length > 0) {
        result[title] = messages;
      }
    }

    return result;
  }

  public async getNormalizedData(
    from: Date,
    to: Date,
  ): Promise<IConnectorNormalizedData> {
    const raw = await this.getRawData(from, to);
    const result: IConnectorNormalizedData = {};

    for (const [channelName, messages] of Object.entries(raw)) {
      result[channelName] = messages.map((msg) => ({
        timestamp: msg.date.toISOString(),
        text: msg.text,
        author: channelName,
        ...(msg.media && { media: msg.media }),
      }));
    }

    return result;
  }

  public async getChannels(): Promise<ChannelInfo[]> {
    const dialogs = await this.client.getDialogs({});

    return dialogs
      .filter((d) => d.entity instanceof Api.Channel)
      .map((d) => {
        const entity = d.entity as Api.Channel;
        return {
          id: entity.id.toString(),
          title: entity.title,
          username: entity.username ?? null,
        };
      });
  }

  private async getMessages(
    entity: Parameters<TelegramClient["iterMessages"]>[0],
    from: Date,
    to: Date,
  ): Promise<ChannelMessage[]> {
    const messages: ChannelMessage[] = [];

    for await (const message of this.client.iterMessages(entity, {
      offsetDate: Math.floor(to.getTime() / 1000) + 1,
      reverse: false,
    })) {
      if (!(message instanceof Api.Message)) continue;

      const date = new Date(message.date * 1000);

      if (date > to) continue;
      if (date < from) break;

      // skip comments (replies inside a thread)
      if (
        message.replyTo &&
        (message.replyTo as Api.MessageReplyHeader).replyToMsgId
      )
        continue;

      messages.push({
        id: message.id,
        date,
        text: message.message,
        views: message.views ?? null,
        media: message.media,
      });
    }

    return messages;
  }
}
