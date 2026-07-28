export type ConnectorCommit = <Result>(operation: () => Result) => Promise<Result>;

export const commitImmediately: ConnectorCommit = async (operation) => operation();
