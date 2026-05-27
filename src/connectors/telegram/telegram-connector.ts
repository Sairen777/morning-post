import { Api, TelegramClient } from "telegram";
import type { Connector, Media, NormalizedData } from "../connector.types.ts";

import type {
  ChannelMessage,
  TelegramConnectorRawData,
} from "./telegram-connector.types.ts";
import { ConnectorId, CONNECTORS_MEDIA_DIR } from "../../constants.ts";
import { DEFAULT_EXCLUDED_CHANNELS } from "./constants.ts";

type IterableEntity = Parameters<TelegramClient["iterMessages"]>[0];

export class TelegramConnector implements Connector<TelegramConnectorRawData> {
  private excludedChannels = [...DEFAULT_EXCLUDED_CHANNELS];
  private mediaDirReady = false;

  constructor(private client: TelegramClient) {}

  public async getRawData(
    from: number,
    to: number,
  ): Promise<TelegramConnectorRawData> {
    const result: TelegramConnectorRawData = {};
    const fromUnix = Math.floor(from / 1000);

    // `iterDialogs` yields pinned dialogs first, then non-pinned by last-message-date
    // descending. Its `offsetDate` parameter is a "start pagination at dialogs <= X"
    // cursor (the wrong direction for us — we want last-message >= from), so we
    // filter ourselves. `continue` rather than `break` because a still-active dialog
    // can come right after an old pinned one.
    for await (const dialog of this.client.iterDialogs({})) {
      if (!dialog.message || dialog.message.date < fromUnix) continue;

      const entity = dialog.entity;
      if (!entity) continue;

      const entityTitle = dialog.title || entity.id.toString();
      if (this.excludedChannels.includes(entityTitle)) continue;

      const isGroup =
        (entity instanceof Api.Channel && entity.megagroup === true) ||
        entity instanceof Api.Chat;
      const channelUsername = entity instanceof Api.Channel
        ? (entity.username ?? null)
        : null;

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
    // TODO: caching for repeat calls in a short window belongs with the DB layer
    // (see ROADMAP) — once persistence is in place, hit cache before refetching.
    const raw = await this.getRawData(from, to);
    const result: NormalizedData = {};

    for (
      const [channelName, { isGroup, messages }] of Object.entries(rawData)
    ) {
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

  private async getMessagesFromEntity(
    entity: IterableEntity,
    from: number,
    to: number,
    channelUsername: string | null,
    isGroup: boolean,
  ): Promise<ChannelMessage[]> {
    const collected: ChannelMessage[] = [];

    for await (
      const apiMessage of this.iterateMessagesInRange(entity, from, to)
    ) {
      const message = await this.toChannelMessage(
        apiMessage,
        channelUsername,
        isGroup,
      );
      if (message) collected.push(message);
    }

    const quotedTextMap = await this.fetchQuotedTexts(entity, collected);
    return mergeAlbums(collected, quotedTextMap);
  }

  // `iterMessages` walks backward in time from offsetDate=to+1. Messages should
  // arrive with date ≤ to (defensive skip stays in case of edge cases), and once
  // we cross below `from` everything older is irrelevant — stop iterating.
  private async *iterateMessagesInRange(
    entity: IterableEntity,
    from: number,
    to: number,
  ): AsyncGenerator<Api.Message> {
    for await (
      const message of this.client.iterMessages(entity, {
        offsetDate: Math.floor(to / 1000) + 1,
        reverse: false,
      })
    ) {
      // iterMessages may also yield MessageService (joins/pins/calls) or
      // MessageEmpty (deleted/error) — only Api.Message carries what we need.
      if (!(message instanceof Api.Message)) continue;

      const messageMs = message.date * 1000;
      if (messageMs > to) continue;
      if (messageMs < from) return;

      yield message;
    }
  }

  private async toChannelMessage(
    apiMessage: Api.Message,
    channelUsername: string | null,
    isGroup: boolean,
  ): Promise<ChannelMessage | null> {
    const media = await this.processMedia(apiMessage, isGroup);
    if (!apiMessage.message.trim() && !media) return null;

    return {
      id: apiMessage.id,
      date: new Date(apiMessage.date * 1000),
      text: apiMessage.message,
      views: apiMessage.views ?? null,
      author: isGroup ? this.resolveAuthor(apiMessage.sender) : null,
      url: channelUsername
        ? `https://t.me/${channelUsername}/${apiMessage.id}`
        : undefined,
      media,
      groupedId: apiMessage.groupedId?.toString() ?? null,
      replyToMessageId:
        (apiMessage.replyTo as Api.MessageReplyHeader)?.replyToMsgId ?? null,
    };
  }

  private async processMedia(
    message: Api.Message,
    isGroup: boolean,
  ): Promise<Media | undefined> {
    if (message.media instanceof Api.MessageMediaPhoto) {
      // skip photo download for groups — images are usually memes and waste tokens
      return isGroup ? undefined : await this.downloadPhoto(message);
    }
    if (message.media) {
      return this.extractNonPhotoMedia(message.media);
    }
    return undefined;
  }

  // Best-effort: batch-fetches the text of any message that was replied to, so
  // mergeAlbums can prepend quote context. Failures are swallowed — quote
  // context is a nice-to-have, not load-bearing.
  private async fetchQuotedTexts(
    entity: IterableEntity,
    messages: ChannelMessage[],
  ): Promise<Map<number, string>> {
    const quotedIds = [
      ...new Set(
        messages
          .map((m) => m.replyToMessageId)
          .filter((id): id is number => id != null),
      ),
    ];

    const result = new Map<number, string>();
    if (quotedIds.length === 0) return result;

    try {
      const fetched = await this.client.getMessages(entity, { ids: quotedIds });
      for (const m of fetched) {
        if (m instanceof Api.Message && m.message) {
          result.set(m.id, m.message);
        }
      }
    } catch {
      // quote fetching is best-effort — don't drop messages if it fails
    }
    return result;
  }

  private async downloadPhoto(message: Api.Message): Promise<Media> {
    await this.ensureMediaDir();
    const buffer = (await this.client.downloadMedia(message, {})) as Uint8Array;
    // Lazy-import sharp: heavy native dep that wants --allow-sys/--allow-ffi.
    // Keeping it out of the module top means tests can import the connector
    // without the native binding having to load.
    const { default: sharp } = await import("sharp");
    // `fit: "inside"` scales to fit within 512x512 while preserving aspect ratio
    // (no crop, no squash).
    const resized = await sharp(buffer)
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 75 })
      .toBuffer();
    const localPath = `${CONNECTORS_MEDIA_DIR.Telegram}/${message.id}.jpg`;
    await Deno.writeFile(localPath, resized);
    return { type: "photo", localPath };
  }

  private async ensureMediaDir(): Promise<void> {
    if (this.mediaDirReady) return;
    await Deno.mkdir(CONNECTORS_MEDIA_DIR.Telegram, { recursive: true });
    this.mediaDirReady = true;
  }

  private resolveAuthor(sender?: Api.TypeEntityLike): string | null {
    if (!sender) return null;
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
        if (mime.startsWith("video/")) return { type: "video" };
        return { type: "document", mimeType: mime };
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Album / quote folding — Telegram-internal helpers, file-private. Telegram
// delivers album posts (multiple photos shared together) as N separate
// messages sharing the same `groupedId`. We fold each group into one message
// so the summarizer sees one item per post, and inline replied-to text into
// the message body so the LLM has the conversation context.
// ---------------------------------------------------------------------------

function prependQuote(
  text: string,
  replyToMessageId: number | null,
  quotedTextMap: Map<number, string>,
): string {
  const quote = replyToMessageId
    ? quotedTextMap.get(replyToMessageId)
    : undefined;
  if (!quote) return text;
  return `[QUOTED_MESSAGE]${quote}[/QUOTED_MESSAGE]\n\n${text}`;
}

function mergeAlbums(
  raw: ChannelMessage[],
  quotedTextMap: Map<number, string>,
): ChannelMessage[] {
  const albumGroups = groupByAlbum(raw);
  const emitted = new Set<string>();

  return raw.flatMap((message) => {
    if (!message.groupedId) {
      return [{
        ...message,
        text: prependQuote(
          message.text,
          message.replyToMessageId,
          quotedTextMap,
        ),
      }];
    }
    if (emitted.has(message.groupedId)) return [];
    emitted.add(message.groupedId);
    return [foldAlbumGroup(albumGroups.get(message.groupedId)!, quotedTextMap)];
  });
}

function groupByAlbum(
  messages: ChannelMessage[],
): Map<string, ChannelMessage[]> {
  const grouped = messages.filter(
    (m): m is ChannelMessage & { groupedId: string } => m.groupedId !== null,
  );
  return Map.groupBy(grouped, (m) => m.groupedId);
}

function foldAlbumGroup(
  group: ChannelMessage[],
  quotedTextMap: Map<number, string>,
): ChannelMessage {
  const first = group[0];
  const captionSource = group.find((m) => m.text.trim());
  return {
    id: first.id,
    date: first.date,
    text: prependQuote(
      captionSource?.text ?? "",
      captionSource?.replyToMessageId ?? null,
      quotedTextMap,
    ),
    views: first.views,
    author: first.author,
    groupedId: null,
    replyToMessageId: null,
    media: foldAlbumMedia(group),
  };
}

function foldAlbumMedia(group: ChannelMessage[]): Media | undefined {
  const photoPaths = group
    .filter((m) => m.media?.type === "photo")
    .map((m) => (m.media as { type: "photo"; localPath: string }).localPath);

  if (photoPaths.length > 1) return { type: "album", localPaths: photoPaths };
  if (photoPaths.length === 1) {
    return { type: "photo", localPath: photoPaths[0] };
  }
  return group.find((m) => m.media)?.media;
}
