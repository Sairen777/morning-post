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

// TODO: insanely hard logic, simplify it, preferably using telegram api parameters
export function mergeAlbums(
  raw: ChannelMessage[],
  albumGroups: Map<string, ChannelMessage[]>,
  quotedTextMap: Map<number, string>,
): ChannelMessage[] {
  const emitted = new Set<string>();
  const result: ChannelMessage[] = [];

  for (const message of raw) {
    if (!message.groupedId) {
      result.push({
        ...message,
        text: prependQuote(message.text, message.replyToMessageId, quotedTextMap),
      });
      continue;
    }
    if (emitted.has(message.groupedId)) continue;
    emitted.add(message.groupedId);

    const group = albumGroups.get(message.groupedId)!;
    const messageWithText = group.find((m) => m.text.trim());
    const text = prependQuote(
      messageWithText?.text ?? "",
      messageWithText?.replyToMessageId ?? null,
      quotedTextMap,
    );
    const photos = group
      .filter((m) => m.media?.type === "photo")
      .map((m) => (m.media as { type: "photo"; localPath: string }).localPath);

    result.push({
      id: message.id,
      date: message.date,
      text,
      views: message.views,
      author: message.author,
      groupedId: null,
      replyToMessageId: null,
      media:
        photos.length > 1
          ? { type: "album", localPaths: photos }
          : photos.length === 1
            ? { type: "photo", localPath: photos[0] }
            : group.find((m) => m.media)?.media,
    });
  }

  return result;
}
