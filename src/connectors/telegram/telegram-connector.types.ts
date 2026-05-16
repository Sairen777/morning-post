export interface ChannelInfo {
  id: string;
  title: string;
  username: string | null;
}

export interface ChannelMessage {
  id: number;
  date: Date;
  text: string;
  views: number | null;
  // TODO: change later
  media?: any;
}
