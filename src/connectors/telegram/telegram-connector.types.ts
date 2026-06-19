import type { Media } from "../connector.types.ts";

export interface ChannelMessage {
  id: number;
  date: Date;
  text: string;
  views: number | null;
  author: string | null;
  url?: string;
  media?: Media;
  groupedId: string | null;
  replyToMessageId: number | null;
}

export type TelegramConnectorRawData = Record<
  string,
  { feedName: string; isGroup: boolean; messages: ChannelMessage[] }
>;
