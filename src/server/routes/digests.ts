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
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import { computeDigestPeriod } from "../../scheduler/digest-job.ts";
import { runForUser } from "../../services/orchestrator.ts";
import { validate } from "../validate.ts";

const digestIdSchema = z.string().uuid("id must be a valid UUID");

const digestRunBodySchema = z
  .object({
    periodStartMs: z.number().int().nonnegative().optional(),
    periodEndMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (data) => !((data.periodStartMs === undefined) !== (data.periodEndMs === undefined)),
    { message: "periodStartMs and periodEndMs must be provided together" },
  )
  .refine(
    (data) =>
      data.periodStartMs === undefined ||
      data.periodEndMs === undefined ||
      data.periodStartMs <= data.periodEndMs,
    { message: "periodStartMs must be before or equal to periodEndMs" },
  );

const DIGEST_RUN_RATE_LIMIT = { limit: 3, windowMs: 5 * 60_000 };

function parseDigestId(rawId: string): { id: string; markdown: boolean } {
  const markdown = rawId.endsWith(".md");
  const id = markdown ? rawId.slice(0, -3) : rawId;
  return { id: validate(digestIdSchema, id), markdown };
}

export function buildDigestRoutes(database: Database): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();

  const digestInstanceId = crypto.randomUUID();
  const runDigestRateLimiter = createRateLimitMiddleware({
    bucket: digestInstanceId + ":digest-run",
    ...DIGEST_RUN_RATE_LIMIT,
    key: (context) => context.var.userId,
  });

  routes.use("*", requireAuth(database));

  routes.post("/run", runDigestRateLimiter, async (context) => {
    const body = await context.req.json();
    const { periodStartMs, periodEndMs } = validate(digestRunBodySchema, body);

    let startMs: number;
    let endMs: number;
    if (periodStartMs !== undefined && periodEndMs !== undefined) {
      startMs = periodStartMs;
      endMs = periodEndMs;
    } else {
      const period = await computeDigestPeriod(database, context.var.userId, Date.now());
      startMs = period.startMs;
      endMs = period.endMs;
    }

    const digest = await runForUser(database, context.var.userId, { startMs, endMs });
    return context.json(digest, 200);
  });

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
