export enum ConnectorId {
  Telegram = "Telegram",
  Substack = "Substack",
  YouTube = "YouTube",
  Reddit = "Reddit",
  X = "X",
  RSS = "RSS",
}

export const DEFAULT_MAXIMUM_STORIES_PER_DIGEST = 20;

export const CONNECTORS_MEDIA_DIR: Record<ConnectorId, string> = {
  [ConnectorId.Telegram]: "telegram_media",
  [ConnectorId.Substack]: "substack_media",
  [ConnectorId.YouTube]: "youtube_media",
  [ConnectorId.Reddit]: "reddit_media",
  [ConnectorId.X]: "x_media",
  [ConnectorId.RSS]: "rss_media",
};
