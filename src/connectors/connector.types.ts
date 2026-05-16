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
  media?: IMedia;
  comments?: Array<IComment>;
}

interface IComment {
  timestamp: string;
  author: string;
  text: string;
  media?: IMedia;
}

// TODO: add proepr media types later
type IMedia = Record<string, any>;
