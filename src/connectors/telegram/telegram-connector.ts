import { Api, TelegramClient } from "telegram";
import sharp from "sharp";
import type {
  Connector,
  Media,
  NormalizedData,
} from "../connector.types.ts";

import type {
  ChannelInfo,
  ChannelMessage,
  TelegramConnectorRawData,
} from "./telegram-connector.types.ts";
import { CONNECTORS_MEDIA_DIR, ConnectorId } from "../../constants.ts";
import { DEFAULT_EXCLUDED_CHANNELS } from "./constants.ts";
import { mergeAlbums } from "./message-utils.ts";

export class TelegramConnector implements Connector<TelegramConnectorRawData> {
  private excludedChannels = [...DEFAULT_EXCLUDED_CHANNELS];

  constructor(private client: TelegramClient) {
    // TODO: probably should move all such initializations on a higher level?
    // Do not bother with it for now
    Deno.mkdir(CONNECTORS_MEDIA_DIR.Telegram, { recursive: true });
  }

  public async getRawData(
    from: number,
    to: number,
  ): Promise<TelegramConnectorRawData> {
    const result: TelegramConnectorRawData = {};
    const fromUnix = Math.floor(from / 1000);

    // TODO: can use offsetDate param to only get dialogues where last message date > from ?
    for await (const dialog of this.client.iterDialogs({})) {
      if (!dialog.message) {
        continue;
      }

      // TODO: if offset date is possible then this line is redundant
      if (dialog.message.date < fromUnix) {
        continue;
      }

      // entity is either a channel or a group
      const entity = dialog.entity;
      if (!entity) {
        continue;
      }

      const entityTitle = dialog.title || entity.id.toString();

      if (this.excludedChannels.includes(entityTitle)) {
        continue;
      }

      // TODO: isnt instanceof checks are wacky? Telegram may change types and stuff. Why not use actual properties like megagrouo
      const isGroup =
        (entity instanceof Api.Channel && entity.megagroup === true) ||
        entity instanceof Api.Chat;
      const channelUsername =
        entity instanceof Api.Channel ? (entity.username ?? null) : null;

      const messages = await this.getMessagesFromEntity(
        entity,
        from,
        to,
        channelUsername,
        isGroup,
      );

      if (messages.length > 0) {
        result[entityTitle] = { isGroup, messages };
      }
    }

    return result;
  }

  public async getNormalizedData(
    from: number,
    to: number,
  ): Promise<NormalizedData> {
    // TODO: this should be caches somehow, if we call getRawData twice with the same from and to params
    // with some small time interval, second call shoudl return already calculated data instantly
    // dont fix it now if it would be better done with proper backend architecture with db and stuff
    // or maybe we can write it to some in memory cache, but how well would it hehave if we have thousands of
    // parallel requests?
    const raw = await this.getRawData(from, to);
    const result: NormalizedData = {};

    for (const [channelName, { isGroup, messages }] of Object.entries(raw)) {
      result[channelName] = messages.map((message) => ({
        connectorId: ConnectorId.Telegram,
        sourceId: channelName,
        date: message.date.getTime(),
        title: null,
        text: message.text,
        // for groups: use the actual message sender; for channels: use the channel name
        author: message.author ?? channelName,
        url: message.url ?? null,
        media: message.media,
        meta: { isGroup },
      }));
    }

    return result;
  }

  private async getChannels(): Promise<ChannelInfo[]> {
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

  // TODO: method is too big, move logic of downloading media to processMedia method (create it)
  // there also should be something like processQuitedMessages method
  // basically this method doing a lot of different things under hood, very hard to read
  private async getMessagesFromEntity(
    entity: Parameters<TelegramClient["iterMessages"]>[0],
    from: number,
    to: number,
    channelUsername: string | null = null,
    isGroup: boolean = false,
  ): Promise<ChannelMessage[]> {
    const rawMessages = [];
    // TODO: add proper type
    const albumGroups = new Map<string, any[]>();

    for await (const message of this.client.iterMessages(entity, {
      offsetDate: Math.floor(to / 1000) + 1,
      reverse: false,
    })) {
      // TODO: what else can it be? I dont get it
      if (!(message instanceof Api.Message)) {
        continue;
      }

      const date = new Date(message.date * 1000);
      const messageMs = date.getTime();

      // TODO: doesnt offset date solves it?
      if (messageMs > to) {
        continue;
      }

      // TODO: why break here and continue in the previous case?
      if (messageMs < from) {
        break;
      }

      let media: Media | undefined;
      if (message.media instanceof Api.MessageMediaPhoto) {
        // skip photo download for groups — images are usually memes and waste tokens
        if (!isGroup) {
          media = await this.downloadPhoto(message);
        }
      } else if (message.media) {
        media = this.extractNonPhotoMedia(message.media);
      }

      if (!message.message.trim() && !media) {
        continue;
      }

      const author = isGroup ? this.resolveAuthor(message.sender) : null;
      // in case message has multiple media files they all will have same groupedId
      const groupedId = message.groupedId?.toString() ?? null;
      const replyToMessageId = (message.replyTo as Api.MessageReplyHeader)
        ?.replyToMsgId ?? null;
      const url = channelUsername
        ? `https://t.me/${channelUsername}/${message.id}`
        : undefined;
      const channelMessage: ChannelMessage = {
        id: message.id,
        date,
        text: message.message,
        views: message.views ?? null,
        author,
        url,
        media,
        groupedId,
        replyToMessageId,
      };

      rawMessages.push(channelMessage);

      // TODO; add comments here on wtf happening and why
      if (groupedId) {
        const group = albumGroups.get(groupedId) ?? [];
        group.push(channelMessage);
        albumGroups.set(groupedId, group);
      }
    }

    // Batch-fetch all quoted messages in one API call
    const quotedIds = [
      ...new Set(
        rawMessages
          .map((m) => m.replyToMessageId)
          .filter((id): id is number => id != null),
      ),
    ];

    // TODO: wtf happening here
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

    // TODO: method of detching messages returns some "mergeAlbums" method, doesnt make sense logically
    return mergeAlbums(rawMessages, albumGroups, quotedTextMap);
  }

  private async downloadPhoto(message: Api.Message): Promise<Media> {
    const buffer = (await this.client.downloadMedia(message, {})) as Uint8Array;
    const resized = await sharp(buffer)
      // TODO: won't it resize different aspect ratios to square?
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 75 })
      .toBuffer();
    const localPath = `${CONNECTORS_MEDIA_DIR.Telegram}/${message.id}.jpg`;
    await Deno.writeFile(localPath, resized);
    return { type: "photo", localPath };
  }

  private resolveAuthor(sender?: Api.TypeEntityLike): string | null {
    if (!sender) {
      return null;
    }

    if (sender instanceof Api.User) {
      return sender.username
        ? `@${sender.username}`
        : [sender.firstName, sender.lastName].filter(Boolean).join(" ") || null;
    }

    if (sender instanceof Api.Channel) {
      return sender.title ?? null;
    }

    return null;
  }

  private extractNonPhotoMedia(
    media: Api.TypeMessageMedia,
  ): Media | undefined {
    if (media instanceof Api.MessageMediaWebPage) {
      const page = media.webpage;

      if (page instanceof Api.WebPage && page.url) {
        return { type: "webpage", url: page.url };
      }

      return undefined;
    }

    if (media instanceof Api.MessageMediaDocument) {
      const doc = media.document;

      if (doc instanceof Api.Document) {
        const mime = doc.mimeType;

        if (mime.startsWith("video/")) {
          return { type: "video" };
        }

        return { type: "document", mimeType: mime };
      }
    }

    return undefined;
  }
}
