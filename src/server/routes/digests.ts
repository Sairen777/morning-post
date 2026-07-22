import { Hono } from "hono";
import { z } from "zod";
import { getConfig } from "../../config.ts";
import type { Database } from "../../db/client.ts";
import {
  buildDigestViewById,
  renderDigestMarkdown,
} from "../../services/digest-service.ts";
import {
  listDigestRunPageForUser,
  findDigestRunForUser,
  listDigestRunFeedsForRun,
} from "../../repositories/digest-run-repository.ts";
import { listDigestPageForUser, deleteDigestForUser } from "../../repositories/digest-repository.ts";
import {
  type AuthVariables,
  requireAuth,
} from "../middleware/require-auth.ts";
import { createRateLimitMiddleware } from "../middleware/rate-limit.ts";
import type { runForUser as runForUserType } from "../../services/orchestrator.ts";
import type { SummarizerService } from "../../summarizers/summarizer.types.ts";
import { validate } from "../validate.ts";
import { NotFoundError } from "../errors.ts";
import { parseLimit } from "../cursor.ts";

const digestRunIdSchema = z.string().uuid("id must be a valid UUID");

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

export interface DigestRouteOptions {
  trustedProxyCount?: number;
  summarizer?: SummarizerService;
  runForUser?: typeof runForUserType;
}

export function buildDigestRoutes(
  database: Database,
  options: DigestRouteOptions = {},
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const trustedProxyCount = options.trustedProxyCount ?? getConfig().trustedProxyCount;
  const runDigestRateLimiter = createRateLimitMiddleware({
    database,
    bucket: "digest-run",
    trustedProxyCount,
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
      try {
        // Deliberately lazy: scheduler code pulls in Telegram connectors only when a digest runs.
        const { computeDigestPeriod } = await import("../../scheduler/digest-job.ts");
        const period = await computeDigestPeriod(database, context.var.userId, Date.now());
        startMs = period.startMs;
        endMs = period.endMs;
      } catch (error) {
        throw new Error("Failed to load digest scheduler", { cause: error });
      }
    }

    let runForUser: typeof runForUserType;
    if (options.runForUser) {
      runForUser = options.runForUser;
    } else {
      try {
        // Deliberately lazy: orchestrator and Telegram connectors are used only by this mutation.
        ({ runForUser } = await import("../../services/orchestrator.ts"));
      } catch (error) {
        throw new Error("Failed to load digest orchestrator", { cause: error });
      }
    }
    const digest = await runForUser(database, context.var.userId, { startMs, endMs }, {
      summarizer: options.summarizer,
    });
    return context.json(digest, 200);
  });

  routes.get("/", async (context) => {
    const url = new URL(context.req.url);
    const cursor = url.searchParams.get("cursor") || undefined;
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await listDigestPageForUser(database, context.var.userId, { cursor, limit });
    return context.json(page, 200);
  });

  routes.get("/runs", async (context) => {
    const url = new URL(context.req.url);
    const cursor = url.searchParams.get("cursor") || undefined;
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await listDigestRunPageForUser(database, context.var.userId, { cursor, limit });
    return context.json(page, 200);
  });

  routes.get("/runs/:id", async (context) => {
    const id = validate(digestRunIdSchema, context.req.param("id"));
    const run = await findDigestRunForUser(database, id, context.var.userId);
    if (!run) {
      throw new NotFoundError("digest run not found");
    }
    const feeds = await listDigestRunFeedsForRun(database, run.id, context.var.userId);
    return context.json({ run, feeds }, 200);
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

  routes.delete("/:id", async (context) => {
    const id = validate(digestIdSchema, context.req.param("id"));
    const digest = await deleteDigestForUser(database, id, context.var.userId);
    return context.json(digest, 200);
  });

  return routes;
}

