import { TelegramClient } from "npm:telegram@^2.26.22";
import { Api } from "npm:telegram@^2.26.22";
import sharp from "npm:sharp@^0.33";
import type {
  IConnector,
  IConnectorNormalizedData,
  IMedia,
} from "../connector.types.ts";
import type {
  ChannelInfo,
  ChannelMessage,
} from "./telegram-connector.types.ts";
import { mergeAlbums, type RawMsg } from "./message-utils.ts";
export { mergeAlbums, prependQuote, type RawMsg } from "./message-utils.ts";

type TelegramRawData = Record<
  string,
  { isGroup: boolean; messages: ChannelMessage[] }
>;

function extractNonPhotoMedia(media: Api.TypeMessageMedia): IMedia | undefined {
  if (media instanceof Api.MessageMediaWebPage) {
    const page = media.webpage;
    if (page instanceof Api.WebPage && page.url)
      return { type: "webpage", url: page.url };
    return undefined;
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (doc instanceof Api.Document) {
      const mime = doc.mimeType;
      if (mime.startsWith("video/")) return { type: "video" };
      return { type: "document", mimeType: mime };
    }
  }
  return undefined;
}

function resolveAuthor(sender?: Api.TypeEntityLike): string | null {
  if (!sender) return null;
  if (sender instanceof Api.User) {
    return sender.username
      ? `@${sender.username}`
      : [sender.firstName, sender.lastName].filter(Boolean).join(" ") || null;
  }
  if (sender instanceof Api.Channel) return sender.title ?? null;
  return null;
}

// const DEFAULT_EXCLUDED_CHANNELS = ["Telegram", "/b/ Свидетели сингулярности"];
const DEFAULT_EXCLUDED_CHANNELS = ["Telegram"];

export class TelegramConnector implements IConnector<TelegramRawData> {
  constructor(
    private client: TelegramClient,
    private excludedChannels: string[] = DEFAULT_EXCLUDED_CHANNELS,
    private mediaDir: string = "media",
  ) {
    Deno.mkdir(mediaDir, { recursive: true });
  }

  public async getRawData(from: Date, to: Date): Promise<TelegramRawData> {
    const result: TelegramRawData = {};
    const fromUnix = Math.floor(from.getTime() / 1000);

    for await (const dialog of this.client.iterDialogs({})) {
      if ((dialog.message?.date ?? 0) < fromUnix) continue;

      const entity = dialog.entity;
      if (!entity) continue;

      const title = dialog.title ?? entity.id.toString();
      if (this.excludedChannels.includes(title)) continue;

      const isGroup =
        (entity instanceof Api.Channel && entity.megagroup === true) ||
        entity instanceof Api.Chat;
      const channelUsername =
        entity instanceof Api.Channel ? (entity.username ?? null) : null;

      const messages = await this.getMessages(
        entity,
        from,
        to,
        channelUsername,
        isGroup,
      );

      if (messages.length > 0) {
        result[title] = { isGroup, messages };
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

    for (const [channelName, { isGroup, messages }] of Object.entries(raw)) {
      result[channelName] = messages.map((msg) => ({
        timestamp: msg.date.toISOString(),
        text: msg.text,
        // for groups: use the actual message sender; for channels: use the channel name
        author: msg.author ?? channelName,
        isGroup,
        ...(msg.url && { url: msg.url }),
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
    channelUsername: string | null = null,
    isGroup: boolean = false,
  ): Promise<ChannelMessage[]> {
    const raw: RawMsg[] = [];
    const albumGroups = new Map<string, RawMsg[]>();

    for await (const message of this.client.iterMessages(entity, {
      offsetDate: Math.floor(to.getTime() / 1000) + 1,
      reverse: false,
    })) {
      if (!(message instanceof Api.Message)) continue;

      const date = new Date(message.date * 1000);

      if (date > to) continue;
      if (date < from) break;

      let media: IMedia | undefined;
      if (message.media instanceof Api.MessageMediaPhoto) {
        // skip photo download for groups — images are usually memes and waste tokens
        if (!isGroup) media = await this.downloadPhoto(message);
      } else if (message.media) {
        media = extractNonPhotoMedia(message.media);
      }

      if (!message.message.trim() && !media) continue;

      const author = isGroup
        ? resolveAuthor(message.sender as Api.TypeEntityLike | undefined)
        : null;
      const groupedId = message.groupedId?.toString() ?? null;
      const replyToMsgId =
        (message.replyTo as Api.MessageReplyHeader)?.replyToMsgId ?? null;
      const url = channelUsername
        ? `https://t.me/${channelUsername}/${message.id}`
        : undefined;
      const msg: RawMsg = {
        id: message.id,
        date,
        text: message.message,
        views: message.views ?? null,
        author,
        url,
        media,
        groupedId,
        replyToMsgId,
      };
      raw.push(msg);

      if (groupedId) {
        const group = albumGroups.get(groupedId) ?? [];
        group.push(msg);
        albumGroups.set(groupedId, group);
      }
    }

    // Batch-fetch all quoted messages in one API call
    const quotedIds = [
      ...new Set(
        raw
          .map((m) => m.replyToMsgId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const quotedTextMap = new Map<number, string>();
    if (quotedIds.length > 0) {
      try {
        const fetched = await this.client.getMessages(entity, {
          ids: quotedIds,
        });
        for (const m of fetched) {
          if (m instanceof Api.Message && m.message) {
            quotedTextMap.set(m.id, m.message);
          }
        }
      } catch {
        // quote fetching is best-effort — don't drop messages if it fails
      }
    }

    return mergeAlbums(raw, albumGroups, quotedTextMap);
  }

  private async downloadPhoto(message: Api.Message): Promise<IMedia> {
    const buffer = (await this.client.downloadMedia(message, {})) as Uint8Array;
    const resized = await sharp(buffer)
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 75 })
      .toBuffer();
    const localPath = `${this.mediaDir}/${message.id}.jpg`;
    await Deno.writeFile(localPath, resized);
    return { type: "photo", localPath };
  }
}
