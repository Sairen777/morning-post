import type { Media } from "../connector.types.ts";
import type { ChannelMessage } from "./telegram-connector.types.ts";

export function prependQuote(
  text: string,
  replyToMessageId: number | null,
  quotedTextMap: Map<number, string>,
): string {
  const quote = replyToMessageId ? quotedTextMap.get(replyToMessageId) : undefined;
  if (!quote) return text;
  return `[QUOTED_MESSAGE]${quote}[/QUOTED_MESSAGE]\n\n${text}`;
}

// Telegram delivers album posts (multiple photos shared together) as N separate
// messages sharing the same `groupedId`. Fold each group into one message so the
// summarizer sees one item per post.
export function mergeAlbums(
  raw: ChannelMessage[],
  quotedTextMap: Map<number, string>,
): ChannelMessage[] {
  const albumGroups = groupByAlbum(raw);
  const emitted = new Set<string>();

  return raw.flatMap((message) => {
    if (!message.groupedId) {
      return [{
        ...message,
        text: prependQuote(message.text, message.replyToMessageId, quotedTextMap),
      }];
    }
    if (emitted.has(message.groupedId)) return [];
    emitted.add(message.groupedId);
    return [foldAlbumGroup(albumGroups.get(message.groupedId)!, quotedTextMap)];
  });
}

function groupByAlbum(messages: ChannelMessage[]): Map<string, ChannelMessage[]> {
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
