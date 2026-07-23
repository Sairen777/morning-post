import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Database } from "../db/client.ts";
import { resolveAppSecurityOptions } from "../config.ts";
import { errorHandler, PayloadTooLargeError } from "./errors.ts";
import { createOriginGuard } from "./middleware/origin-guard.ts";
import { buildAuthRoutes } from "./routes/auth.ts";
import { buildConnectorRoutes, type ConnectorRouteDependencies } from "./routes/connectors.ts";
import { buildDigestRoutes, type DigestRouteOptions } from "./routes/digests.ts";
import { buildFeedRoutes, type FeedRouteDependencies } from "./routes/feeds.ts";
import { buildInterestRoutes } from "./routes/interests.ts";
import { buildSourceRoutes } from "./routes/sources.ts";

export interface ServerBindings {
  server: Bun.Server<undefined>;
}

export type ServerEnvironment = {
  Bindings: ServerBindings;
};

export interface AppSecurityOptions {
  allowedOrigins: string[];
  maxRequestBodyBytes: number;
}

export interface AppDependencies {
  connectors?: ConnectorRouteDependencies;
  feeds?: FeedRouteDependencies;
  digests?: DigestRouteOptions;
}

export function buildApp(
  database: Database,
  dependencies: AppDependencies = {},
  options: AppSecurityOptions = resolveAppSecurityOptions(),
): Hono<ServerEnvironment> {
  const app = new Hono<ServerEnvironment>();

  app.onError(errorHandler);

  app.use("*", secureHeaders({
    xFrameOptions: "DENY",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
  }));
  app.use("*", bodyLimit({
    maxSize: options.maxRequestBodyBytes,
    onError: () => {
      throw new PayloadTooLargeError();
    },
  }));
  app.use("*", createOriginGuard(options.allowedOrigins));


  app.get("/health", (context) => {
    return context.json({ ok: true });
  });

  app.route("/auth", buildAuthRoutes(database));
  app.route("/sources", buildSourceRoutes(database));
  app.route("/connectors", buildConnectorRoutes(database, dependencies.connectors));
  app.route("/digests", buildDigestRoutes(database, dependencies.digests));
  app.route("/", buildFeedRoutes(database, dependencies.feeds));
  app.route("/", buildInterestRoutes(database));

  return app;
}
