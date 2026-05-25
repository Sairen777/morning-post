export interface IConnector<T> {
  // TODO: change date to utc timestamp (stuff that Date.now() returns)
  getRawData(from: Date, to: Date): Promise<T>;
  // TODO: change date to utc timestamp (stuff that Date.now() returns)
  getNormalizedData(from: Date, to: Date): Promise<IConnectorNormalizedData>;
}

type IEntityName = string;

export type IConnectorNormalizedData = Record<
  IEntityName,
  Array<IConnectorNormalizedEntityData>
>;

export interface IConnectorNormalizedEntityData {
  timestamp: string;
  text: string;
  author: string;
  url?: string;
  media?: IMedia;
  // this field should be in a "meta: Record<string, unknown>" field
  isGroup?: boolean;
}

export type IMedia =
  | { type: "photo"; localPath: string }
  | { type: "album"; localPaths: string[] }
  | { type: "video" }
  | { type: "document"; mimeType: string }
  | { type: "webpage"; url: string };
