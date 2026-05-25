import type { ChannelMessage } from "./telegram-connector.types.ts";

// TODO: why can't we put those two field to ChannelMessage?
export type RawMsg = ChannelMessage & {
  groupedId: string | null;
  replyToMsgId: number | null;
};

export function prependQuote(
  text: string,
  replyToMsgId: number | null,
  quotedTextMap: Map<number, string>,
): string {
  const quote = replyToMsgId ? quotedTextMap.get(replyToMsgId) : undefined;
  if (!quote) return text;
  return `[QUOTED_MESSAGE]${quote}[/QUOTED_MESSAGE]\n\n${text}`;
}

// TODO: insanely hard logic, simplify it, preferably using telegram api parameters
export function mergeAlbums(
  raw: RawMsg[],
  albumGroups: Map<string, RawMsg[]>,
  quotedTextMap: Map<number, string>,
): ChannelMessage[] {
  const emitted = new Set<string>();
  const result: ChannelMessage[] = [];

  for (const msg of raw) {
    if (!msg.groupedId) {
      result.push({
        ...msg,
        text: prependQuote(msg.text, msg.replyToMsgId, quotedTextMap),
      });
      continue;
    }
    if (emitted.has(msg.groupedId)) continue;
    emitted.add(msg.groupedId);

    const group = albumGroups.get(msg.groupedId)!;
    const textMsg = group.find((m) => m.text.trim());
    const text = prependQuote(
      textMsg?.text ?? "",
      textMsg?.replyToMsgId ?? null,
      quotedTextMap,
    );
    const photos = group
      .filter((m) => m.media?.type === "photo")
      .map((m) => (m.media as { type: "photo"; localPath: string }).localPath);

    result.push({
      id: msg.id,
      date: msg.date,
      text,
      views: msg.views,
      author: msg.author,
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
