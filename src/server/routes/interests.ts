import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import type {
  InterestRuleDisposition,
  InterestRuleKind,
} from "../../personalization/personalization.types.ts";
import {
  createInterest,
  dismissInterest,
  listInterests,
  MAXIMUM_INTEREST_LABEL_LENGTH,
  updateInterest,
} from "../../services/interest-service.ts";
import { type AuthVariables, requireAuth } from "../middleware/require-auth.ts";
import { validate } from "../validate.ts";

const idParamsSchema = z.object({ id: z.string().uuid("id must be a valid UUID") });
const labelSchema = z.string().trim().min(1, "label is required").max(MAXIMUM_INTEREST_LABEL_LENGTH);
const kindSchema = z.enum(["topic", "entity", "phrase", "story_type"]);
const dispositionSchema = z.enum(["prioritize", "show_less", "mute"]);
const expirySchema = z.number().int().nonnegative().nullable();

const createBodySchema = z.object({
  label: labelSchema,
  kind: kindSchema,
  disposition: dispositionSchema,
  origin: z.literal("explicit").optional(),
  strength: z.number().int().min(0).max(100).optional(),
  expiresAt: expirySchema.optional(),
}).strict();

const updateBodySchema = z.object({
  label: labelSchema.optional(),
  kind: kindSchema.optional(),
  disposition: dispositionSchema.optional(),
  strength: z.number().int().min(0).max(100).optional(),
  expiresAt: expirySchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one field is required");

export function buildInterestRoutes(database: Database): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use("*", requireAuth(database));

  routes.get("/interests", async (context) => {
    return context.json(await listInterests(database, context.var.userId), 200);
  });

  routes.post("/interests", async (context) => {
    const input = validate(createBodySchema, await context.req.json());
    const rule = await createInterest(database, {
      ...input,
      userId: context.var.userId,
      kind: input.kind as InterestRuleKind,
      disposition: input.disposition as InterestRuleDisposition,
    });
    return context.json(rule, 201);
  });

  routes.patch("/interests/:id", async (context) => {
    const { id } = validate(idParamsSchema, context.req.param());
    const input = validate(updateBodySchema, await context.req.json());
    const rule = await updateInterest(database, id, context.var.userId, {
      ...input,
      kind: input.kind as InterestRuleKind | undefined,
      disposition: input.disposition as InterestRuleDisposition | undefined,
    });
    return context.json(rule, 200);
  });

  routes.delete("/interests/:id", async (context) => {
    const { id } = validate(idParamsSchema, context.req.param());
    return context.json(await dismissInterest(database, id, context.var.userId), 200);
  });

  return routes;
}
