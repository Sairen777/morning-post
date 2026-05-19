export interface IConnector<T> {
  getRawData(from: Date, to: Date): Promise<T>;
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
  isGroup?: boolean;
  comments?: Array<IComment>;
}

interface IComment {
  timestamp: string;
  author: string;
  text: string;
  media?: IMedia;
}

export type IMedia =
  | { type: "photo"; localPath: string }
  | { type: "album"; localPaths: string[] }
  | { type: "video" }
  | { type: "document"; mimeType: string }
  | { type: "webpage"; url: string };
