import { Hono } from "@hono/hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import {
  buildDigestViewById,
  listDigestViewsForUser,
  renderDigestMarkdown,
} from "../../services/digest-service.ts";
import {
  type AuthVariables,
  requireAuth,
} from "../middleware/require-auth.ts";
import { validate } from "../validate.ts";

const digestIdSchema = z.string().uuid("id must be a valid UUID");

function parseDigestId(rawId: string): { id: string; markdown: boolean } {
  const markdown = rawId.endsWith(".md");
  const id = markdown ? rawId.slice(0, -3) : rawId;
  return { id: validate(digestIdSchema, id), markdown };
}

export function buildDigestRoutes(database: Database): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("*", requireAuth(database));

  routes.get("/", async (context) => {
    const digests = await listDigestViewsForUser(database, context.var.userId);
    return context.json(digests, 200);
  });

  routes.get("/:id", async (context) => {
    const { id, markdown } = parseDigestId(context.req.param("id"));
    const digest = await buildDigestViewById(database, context.var.userId, id);
    if (markdown) {
      return new Response(renderDigestMarkdown(digest), {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return context.json(digest, 200);
  });

  return routes;
}
