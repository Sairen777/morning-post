import type { IMedia } from "../connector.types.ts";

export interface ChannelInfo {
  id: string;
  title: string;
  username: string | null;
}

// TODO: can't we just take it from telegram package? It should be defined there
export interface ChannelMessage {
  id: number;
  date: Date;
  text: string;
  views: number | null;
  author: string | null;
  url?: string;
  media?: IMedia;
  groupedId?: string;
  replyToMsgId?: number;
}

export type TelegramConnectorRawData = Record<
  string,
  { isGroup: boolean; messages: ChannelMessage[] }
>;
