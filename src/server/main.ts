import { getConfig } from "../config.ts";
import { database } from "../db/client.ts";
import { buildApp } from "./app.ts";

const config = getConfig();
const app = buildApp(database);

console.log("Hono is running at http://localhost:" + String(config.port));

Deno.serve({ port: config.port }, app.fetch);
