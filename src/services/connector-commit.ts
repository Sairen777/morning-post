export type ConnectorCommit = <Result>(operation: () => Promise<Result>) => Promise<Result>;

export const commitImmediately: ConnectorCommit = async (operation) => await operation();
