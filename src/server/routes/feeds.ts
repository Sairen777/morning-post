import { Hono } from "hono";
import { z } from "zod";
import type { FeedKind } from "../../connectors/connector.types.ts";
import type { Database } from "../../db/client.ts";
import {
  findFeedById,
  listFeedsForSource,
  listFeedsForUser,
  updateFeed,
} from "../../repositories/feed-repository.ts";
import {
  discoverFeeds,
  type FeedDiscoveryFactory,
  subscribeFeed,
  unsubscribeFeed,
} from "../../services/feed-service.ts";
import {
  type AuthVariables,
  requireAuth,
} from "../middleware/require-auth.ts";
import { NotFoundError } from "../errors.ts";
import { validate } from "../validate.ts";

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAXIMUM_CUSTOM_PROMPT_LENGTH = 10_000;

const idParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

const sourceIdParamsSchema = z.object({
  sourceId: z.string().uuid("sourceId must be a valid UUID"),
});

const feedKindSchema = z.enum(["news", "discussion"]);

const subscribeFeedBodySchema = z.object({
  externalId: z.string().min(1, "externalId is required"),
  name: z.string().min(1, "name is required"),
  kind: feedKindSchema,
  customPrompt: z.string().max(MAXIMUM_CUSTOM_PROMPT_LENGTH).nullable().optional(),
  position: z.number().int().min(POSTGRES_INTEGER_MIN).max(POSTGRES_INTEGER_MAX).nullable().optional(),
}).strict();

const updateFeedBodySchema = z.object({
  kind: feedKindSchema.optional(),
  customPrompt: z.string().max(MAXIMUM_CUSTOM_PROMPT_LENGTH).nullable().optional(),
  position: z.number().int().min(POSTGRES_INTEGER_MIN).max(POSTGRES_INTEGER_MAX).nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

export interface FeedRouteDependencies {
  discoveryFactory?: FeedDiscoveryFactory;
}

function normalizeCustomPrompt(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildFeedRoutes(
  database: Database,
  dependencies: FeedRouteDependencies = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("*", requireAuth(database));

  routes.get("/feeds", async (context) => {
    const feeds = await listFeedsForUser(database, context.var.userId);
    return context.json(feeds, 200);
  });

  routes.get("/sources/:sourceId/feeds", async (context) => {
    const { sourceId } = validate(sourceIdParamsSchema, context.req.param());
    const feeds = await listFeedsForSource(database, sourceId, context.var.userId);
    return context.json(feeds, 200);
  });

  routes.get("/sources/:sourceId/available-feeds", async (context) => {
    const { sourceId } = validate(sourceIdParamsSchema, context.req.param());
    const feeds = await discoverFeeds(database, context.var.userId, sourceId, dependencies.discoveryFactory);
    return context.json(feeds, 200);
  });

  routes.post("/sources/:sourceId/feeds", async (context) => {
    const { sourceId } = validate(sourceIdParamsSchema, context.req.param());
    const body = await context.req.json();
    const input = validate(subscribeFeedBodySchema, body);
    const feed = await subscribeFeed(database, {
      userId: context.var.userId,
      sourceId,
      externalId: input.externalId,
      name: input.name,
      kind: input.kind as FeedKind,
      customPrompt: normalizeCustomPrompt(input.customPrompt),
      position: input.position,
    });
    return context.json(feed, 201);
  });

  routes.get("/feeds/:id", async (context) => {
    const { id } = validate(idParamsSchema, context.req.param());
    const feed = await findFeedById(database, id, context.var.userId);
    if (!feed) {
      throw new NotFoundError("feed not found");
    }
    return context.json(feed, 200);
  });

  routes.patch("/feeds/:id", async (context) => {
    const { id } = validate(idParamsSchema, context.req.param());
    const body = await context.req.json();
    const input = validate(updateFeedBodySchema, body);
    const feed = await updateFeed(database, id, context.var.userId, {
      ...input,
      customPrompt: normalizeCustomPrompt(input.customPrompt),
      kind: input.kind as FeedKind | undefined,
    });
    return context.json(feed, 200);
  });

  routes.delete("/feeds/:id", async (context) => {
    const { id } = validate(idParamsSchema, context.req.param());
    const feed = await unsubscribeFeed(database, id, context.var.userId);
    return context.json(feed, 200);
  });

  return routes;
}
