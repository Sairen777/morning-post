import type { Media } from "../connector.types.ts";

export interface TelegramForwardSource {
  type: "user" | "channel" | "chat" | "unknown";
  id?: string;
  name?: string;
  messageId?: number;
}


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
  threadRootId: number | null;
  forwardedFrom: TelegramForwardSource | null;
  editDate: Date | null;
  isPinned: boolean;
  messageKind: string;
}

export type TelegramConnectorRawData = Record<
  string,
  { feedName: string; isGroup: boolean; messages: ChannelMessage[] }
>;
