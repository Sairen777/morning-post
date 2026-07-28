import { getConfig } from "../config.ts";
import { openDatabase } from "./sqlite.ts";

export type { Database } from "./sqlite.ts";

const runtimeConnection = openDatabase(getConfig().databasePath);
export const database = runtimeConnection.database;
