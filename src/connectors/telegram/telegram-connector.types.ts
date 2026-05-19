export interface ChannelInfo {
  id: string;
  title: string;
  username: string | null;
}

import type { IMedia } from "../connector.types.ts";

export interface ChannelMessage {
  id: number;
  date: Date;
  text: string;
  views: number | null;
  author: string | null;
  url?: string;
  media?: IMedia;
}
