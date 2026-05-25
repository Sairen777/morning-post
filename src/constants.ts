export enum Connector {
  Telegram = "Telegram",
  Substack = "Substack",
  YouTube = "YouTube",
  Reddit = "Reddit",
  X = "X",
  RSS = "RSS",
}

// TODO: ensure unique values on type level if possible?
export const CONNECTORS_MEDIA_DIR: Record<Connector, string> = {
  [Connector.Telegram]: "telegram_media",
  [Connector.Substack]: "substack_media",
  [Connector.YouTube]: "youtube_media",
  [Connector.Reddit]: "reddit_media",
  [Connector.X]: "x_media",
  [Connector.RSS]: "rss_media",
};
