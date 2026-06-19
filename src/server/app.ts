import { Hono } from "@hono/hono";
import type { Database } from "../db/client.ts";
import { errorHandler } from "./errors.ts";
import { buildAuthRoutes } from "./routes/auth.ts";
import { buildConnectorRoutes, type ConnectorRouteDependencies } from "./routes/connectors.ts";
import { buildDigestRoutes } from "./routes/digests.ts";
import { buildFeedRoutes, type FeedRouteDependencies } from "./routes/feeds.ts";
import { buildSourceRoutes } from "./routes/sources.ts";

export interface AppDependencies {
  connectors?: ConnectorRouteDependencies;
  feeds?: FeedRouteDependencies;
}

export function buildApp(database: Database, dependencies: AppDependencies = {}): Hono {
  const app = new Hono();

  app.onError(errorHandler);

  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  app.route("/auth", buildAuthRoutes(database));
  app.route("/sources", buildSourceRoutes(database));
  app.route("/connectors", buildConnectorRoutes(database, dependencies.connectors));
  app.route("/digests", buildDigestRoutes(database));
  app.route("/", buildFeedRoutes(database, dependencies.feeds));

  return app;
}
