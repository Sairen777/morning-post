import { Hono } from "hono";
import { z } from "zod";
import { getXBrowserConfig } from "../../config.ts";
import { ConnectorId } from "../../constants.ts";
import type { XBrowserRuntime } from "../../connectors/x/index.ts";
import type { Database } from "../../db/client.ts";
import {
  deleteSourceCredentials,
  findSourceById,
  listSourcesForUser,
  updateSource,
} from "../../repositories/source-repository.ts";
import { type AuthVariables, requireAuth } from "../middleware/require-auth.ts";
import { NotFoundError } from "../errors.ts";
import { validate } from "../validate.ts";

const sourceParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const updateSourceBodySchema = z.object({
  position: z.number().int().min(POSTGRES_INTEGER_MIN).max(POSTGRES_INTEGER_MAX)
    .nullable().optional(),
  enabled: z.boolean().optional(),
  showPaidPostTitles: z.boolean().optional(),
  relevanceFilterMode: z.enum(["inherit", "personalized", "include_all"]).optional(),
}).strict();

function disconnectMessage(connectorId: string): string {
  if (connectorId === ConnectorId.Telegram) {
    return "Source disconnected. Revoke the Telegram session in Telegram -> Devices.";
  }
  return "Source disconnected.";
}

export interface SourceRouteDependencies {
  xBrowserRuntime?: Pick<XBrowserRuntime, "disconnectProfile">;
}

export function buildSourceRoutes(
  database: Database,
  dependencies: SourceRouteDependencies = {},
): Hono<{ Variables: AuthVariables }> {
  let defaultXBrowserRuntime: Promise<XBrowserRuntime> | undefined;
  const resolveXBrowserRuntime = async (): Promise<
    Pick<XBrowserRuntime, "disconnectProfile">
  > => {
    if (dependencies.xBrowserRuntime) return dependencies.xBrowserRuntime;
    defaultXBrowserRuntime ??= import("../../connectors/x/index.ts").then(
      ({ XBrowserRuntime }) =>
        new XBrowserRuntime({
          profileRoot: getXBrowserConfig().profileRoot,
        }),
    );
    return await defaultXBrowserRuntime;
  };
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("*", requireAuth(database));

  routes.get("/", async (context) => {
    const sources = await listSourcesForUser(database, context.var.userId);
    return context.json(sources, 200);
  });

  routes.patch("/:id", async (context) => {
    const { id } = validate(sourceParamsSchema, context.req.param());
    const body = await context.req.json();
    const updates = validate(updateSourceBodySchema, body);
    const source = await updateSource(
      database,
      id,
      context.var.userId,
      updates,
    );
    return context.json(source, 200);
  });

  routes.delete("/:id", async (context) => {
    const { id } = validate(sourceParamsSchema, context.req.param());
    const userId = context.var.userId;
    const existingSource = await findSourceById(database, id, userId);
    if (!existingSource) {
      throw new NotFoundError("source not found");
    }

    const source = existingSource.connectorId === ConnectorId.X
      ? await (await resolveXBrowserRuntime()).disconnectProfile(
        userId,
        async () => await deleteSourceCredentials(database, id, userId),
        context.req.raw.signal,
      )
      : await deleteSourceCredentials(database, id, userId);
    const revokeTelegramSession = source.connectorId === ConnectorId.Telegram;
    return context.json({
      source,
      revokeTelegramSession,
      message: disconnectMessage(source.connectorId),
    }, 200);
  });

  return routes;
}
