import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { Api, TelegramClient } from "telegram";
import type {
  AvailableFeed,
  Connector,
  FeedKind,
  Media,
  NormalizedData,
} from "../connector.types.ts";

import type {
  ChannelMessage,
  TelegramConnectorRawData,
  TelegramForwardSource,
} from "./telegram-connector.types.ts";
import { ConnectorId, CONNECTORS_MEDIA_DIR } from "../../constants.ts";
import { DEFAULT_EXCLUDED_CHANNELS } from "./constants.ts";
import { getConfig } from "../../config.ts";

type IterableEntity = Parameters<TelegramClient["iterMessages"]>[0];

interface TelegramFeedDetails extends AvailableFeed {
  entity: Api.Channel | Api.Chat | Api.User;
  channelUsername: string | null;
  isGroup: boolean;
}

export class TelegramConnector implements Connector<TelegramConnectorRawData> {
  private excludedChannels = [...DEFAULT_EXCLUDED_CHANNELS];

  constructor(private client: TelegramClient) {}

  public async getRawData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<TelegramConnectorRawData> {
    const result: TelegramConnectorRawData = {};
    if (feedExternalIds?.length === 0) return result;
    const selectedFeedExternalIds = feedExternalIds === undefined ? null : new Set(feedExternalIds);
    const fromUnix = Math.floor(from / 1000);

    // `iterDialogs` yields pinned dialogs first, then non-pinned by last-message-date
    // descending. Its `offsetDate` parameter is a "start pagination at dialogs <= X"
    // cursor (the wrong direction for us — we want last-message >= from), so we
    // filter ourselves. `continue` rather than `break` because a still-active dialog
    // can come right after an old pinned one.
    for await (const dialog of this.client.iterDialogs({})) {
      if (!dialog.message || dialog.message.date < fromUnix) continue;

      const details = this.toFeedDetails(dialog.title, dialog.entity, true);
      if (!details || this.isExcludedFeed(details)) continue;
      if (selectedFeedExternalIds !== null && !selectedFeedExternalIds.has(details.externalId)) continue;

      const feedKey = details.externalId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const messages = await this.getMessagesFromEntity(
        details.entity,
        from,
        to,
        details.channelUsername,
        details.isGroup,
        signal,
        feedKey,
      );

      if (messages.length > 0) {
        result[details.externalId] = { feedName: details.name, isGroup: details.isGroup, messages };
      }
    }

    return result;
  }
  public async getNormalizedData(
    from: number,
    to: number,
    feedExternalIds?: string[],
    signal?: AbortSignal,
  ): Promise<NormalizedData> {
    const rawData = await this.getRawData(from, to, feedExternalIds, signal);
    // TODO: caching for repeat calls in a short window belongs with the DB layer
    // (see ROADMAP) — once persistence is in place, hit cache before refetching.
    const result: NormalizedData = {};

    for (
      const [feedExternalId, { feedName, isGroup, messages }] of Object.entries(rawData)
    ) {
      result[feedExternalId] = messages.map((message) => ({
        connectorId: ConnectorId.Telegram,
        feedExternalId,
        externalId: message.id.toString(),
        date: message.date.getTime(),
        title: null,
        text: message.text,
        // for groups: use the actual message sender; for channels: use the feed name
        author: message.author ?? feedName,
        url: message.url ?? null,
        media: message.media,
        meta: {
          isGroup,
          messageKind: message.messageKind,
          ...(message.replyToMessageId === null ? {} : {
            replyToMessageId: message.replyToMessageId,
          }),
          ...(message.threadRootId === null ? {} : {
            threadRootId: message.threadRootId,
          }),
          ...(message.forwardedFrom === null ? {} : {
            forwardedFrom: message.forwardedFrom,
          }),
          ...(message.editDate === null ? {} : {
            editDate: message.editDate.getTime(),
          }),
          ...(message.isPinned ? { isPinned: true } : {}),
          ...(message.groupedId === null ? {} : { groupedId: message.groupedId }),
        },
      }));
    }

    return result;
  }

  public async listAvailableFeeds(): Promise<AvailableFeed[]> {
    const feeds: AvailableFeed[] = [];

    for await (const dialog of this.client.iterDialogs({})) {
      const details = this.toFeedDetails(dialog.title, dialog.entity, true);
      if (!details || this.isExcludedFeed(details)) continue;

      feeds.push({
        externalId: details.externalId,
        name: details.name,
        kind: details.kind,
      });
    }

    return feeds;
  }

  private toFeedDetails(
    dialogTitle: string | null | undefined,
    entity: Api.TypeEntityLike | null | undefined,
    includePrivateDialogs = false,
  ): TelegramFeedDetails | null {
    if (!entity) return null;
    if (
      !(entity instanceof Api.Channel || entity instanceof Api.Chat) &&
      !(includePrivateDialogs && entity instanceof Api.User)
    ) {
      return null;
    }

    const entityId = entity.id.toString();
    const name = dialogTitle || entityId;
    const isGroup = this.isDiscussionEntity(entity);

    return {
      entity,
      externalId: this.toExternalId(entity),
      name,
      kind: this.toFeedKind(isGroup),
      channelUsername: entity instanceof Api.Channel
        ? (entity.username ?? null)
        : null,
      isGroup,
    };
  }
  private isExcludedFeed(feed: AvailableFeed): boolean {
    return this.excludedChannels.includes(feed.externalId) ||
      this.excludedChannels.includes(feed.name);
  }

  private isDiscussionEntity(
    entity: Api.Channel | Api.Chat | Api.User,
  ): boolean {
    return entity instanceof Api.User ||
      (entity instanceof Api.Channel && entity.megagroup === true) ||
      entity instanceof Api.Chat;
  }

  private toFeedKind(isGroup: boolean): FeedKind {
    return isGroup ? "discussion" : "news";
  }

  private toExternalId(entity: Api.Channel | Api.Chat | Api.User): string {
    if (entity instanceof Api.Channel) {
      return `channel:${entity.id.toString()}`;
    }
    if (entity instanceof Api.Chat) {
      return `chat:${entity.id.toString()}`;
    }
    return `user:${entity.id.toString()}`;
  }

  private async getMessagesFromEntity(
    entity: IterableEntity,
    from: number,
    to: number,
    channelUsername: string | null,
    isGroup: boolean,
    signal?: AbortSignal,
    feedKey?: string,
  ): Promise<ChannelMessage[]> {
    const collected: ChannelMessage[] = [];
    for await (
      const apiMessage of this.iterateMessagesInRange(entity, from, to, signal)
    ) {
      const message = await this.toChannelMessage(
        apiMessage,
        channelUsername,
        isGroup,
        feedKey,
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
    signal?: AbortSignal,
  ): AsyncGenerator<Api.Message> {
    if (signal?.aborted) return;
    for await (
      const message of this.client.iterMessages(entity, {
        offsetDate: Math.floor(to / 1000) + 1,
        reverse: false,
      })
    ) {
      if (signal?.aborted) return;
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
    feedKey?: string,
  ): Promise<ChannelMessage | null> {
    const media = await this.processMedia(apiMessage, isGroup, feedKey);
    if (!apiMessage.message.trim() && !media) return null;

    const replyHeader = apiMessage.replyTo as Api.MessageReplyHeader | undefined;
    return {
      id: apiMessage.id,
      date: new Date(apiMessage.date * 1000),
      text: cleanupTelegramBoilerplate(apiMessage.message),
      views: apiMessage.views ?? null,
      author: isGroup ? this.resolveAuthor(apiMessage.sender) : null,
      url: channelUsername
        ? `https://t.me/${channelUsername}/${apiMessage.id}`
        : undefined,
      media,
      groupedId: apiMessage.groupedId?.toString() ?? null,
      replyToMessageId: replyHeader?.replyToMsgId ?? null,
      threadRootId: replyHeader?.replyToTopId ?? null,
      forwardedFrom: resolveForwardSource(apiMessage.fwdFrom),
      editDate: apiMessage.editDate == null
        ? null
        : new Date(apiMessage.editDate * 1000),
      isPinned: apiMessage.pinned === true,
      messageKind: resolveMessageKind(apiMessage),
    };
  }

  private async processMedia(
    message: Api.Message,
    isGroup: boolean,
    feedKey?: string,
  ): Promise<Media | undefined> {
    if (message.media instanceof Api.MessageMediaPhoto) {
      // skip photo download for groups — images are usually memes and waste tokens
      return isGroup ? undefined : await this.downloadPhoto(message, feedKey);
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

  private async downloadPhoto(message: Api.Message, feedKey?: string): Promise<Media> {
    const subDir = feedKey ? `${CONNECTORS_MEDIA_DIR.Telegram}/${feedKey}` : CONNECTORS_MEDIA_DIR.Telegram;
    await mkdir(subDir, { recursive: true });
    const buffer = (await this.client.downloadMedia(message, {})) as Uint8Array;
    // Lazy-import sharp so the native binding loads only when an image is processed.
    const { default: sharp } = await import("sharp");
    // `fit: "inside"` scales to fit within 512x512 while preserving aspect ratio
    // (no crop, no squash).
    const resized = await sharp(buffer)
      .resize(512, 512, { fit: "inside" })
      .jpeg({ quality: 75 })
      .toBuffer();
    const localPath = `${subDir}/${message.id}.jpg`;
    // Enforce quota before write: delete oldest files under the connector media root
    // until the new file fits.
    await enforceMediaQuota(CONNECTORS_MEDIA_DIR.Telegram, getConfig().mediaQuotaBytes, resized.length);
    await writeFile(localPath, resized);
    return { type: "photo", localPath };
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
function resolveForwardSource(
  header: Api.MessageFwdHeader | undefined,
): TelegramForwardSource | null {
  if (!header) return null;
  const peer = header.fromId;
  const identity: TelegramForwardSource = peer instanceof Api.PeerUser
    ? { type: "user", id: peer.userId.toString() }
    : peer instanceof Api.PeerChannel
    ? { type: "channel", id: peer.channelId.toString() }
    : peer instanceof Api.PeerChat
    ? { type: "chat", id: peer.chatId.toString() }
    : { type: "unknown" };
  if (header.fromName) identity.name = header.fromName;
  else if (header.postAuthor) identity.name = header.postAuthor;
  if (header.channelPost != null) identity.messageId = header.channelPost;
  return identity;
}

function resolveMessageKind(message: Api.Message): string {
  const media = message.media;
  if (!media) return "text";
  if (media instanceof Api.MessageMediaPhoto) return "photo";
  if (media instanceof Api.MessageMediaWebPage) return "webpage";
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document;
    if (document instanceof Api.Document && document.mimeType.startsWith("video/")) {
      return "video";
    }
    return "document";
  }
  return "other-media";
}

/**
 * Telegram relays sometimes duplicate a wrapper or footer line verbatim.
 * Collapse only adjacent, exact duplicates. URL lines and quote bodies are
 * deliberately excluded because repetition there can carry provenance.
 */
export function cleanupTelegramBoilerplate(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""));
  const cleaned: string[] = [];
  let insideQuote = false;
  for (const line of lines) {
    const duplicate = cleaned.at(-1) === line;
    const containsUrl = /(?:https?:\/\/|t\.me\/)/iu.test(line);
    if (!(duplicate && line !== "" && !containsUrl && !insideQuote)) {
      cleaned.push(line);
    }
    if (line.includes("[QUOTED_MESSAGE]")) insideQuote = true;
    if (line.includes("[/QUOTED_MESSAGE]")) insideQuote = false;
  }
  while (cleaned[0] === "") cleaned.shift();
  while (cleaned.at(-1) === "") cleaned.pop();
  return cleaned.join("\n");
}


// ---------------------------------------------------------------------------
// Media quota enforcement — module-level helper
// ---------------------------------------------------------------------------

/** Walk `dir` recursively, collecting all file stats. */
async function collectFilesRecursive(
  dir: string,
): Promise<{ path: string; size: number; mtime: number }[]> {
  const files: { path: string; size: number; mtime: number }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursive(fullPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      try {
        const fileStat = await stat(fullPath);
        files.push({ path: fullPath, size: fileStat.size, mtime: fileStat.mtimeMs });
      } catch {
        // stat failed — skip this file
      }
    }
  }
  return files;
}

/** Delete oldest files under `dir` (recursively) until total size fits `quotaBytes` for `newFileBytes`. */
export async function enforceMediaQuota(
  dir: string,
  quotaBytes: number,
  newFileBytes: number,
): Promise<void> {
  const files = await collectFilesRecursive(dir);
  let currentTotal = files.reduce((sum, f) => sum + f.size, 0);
  if (currentTotal + newFileBytes <= quotaBytes) return;

  // Sort oldest first by mtime, secondary by name for determinism
  files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));

  for (const file of files) {
    if (currentTotal + newFileBytes <= quotaBytes) break;
    try {
      await unlink(file.path);
      currentTotal -= file.size;
    } catch {
      // deletion failure — continue with next file
    }
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
    url: first.url,
    groupedId: first.groupedId,
    replyToMessageId: captionSource?.replyToMessageId ?? null,
    threadRootId: captionSource?.threadRootId ?? null,
    forwardedFrom: captionSource?.forwardedFrom ?? null,
    editDate: captionSource?.editDate ?? first.editDate,
    isPinned: group.some((message) => message.isPinned),
    messageKind: "album",
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
