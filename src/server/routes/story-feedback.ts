import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../../db/client.ts";
import { MAXIMUM_INTEREST_LABEL_LENGTH } from "../../services/interest-service.ts";
import { submitStoryFeedback } from "../../services/story-feedback-service.ts";
import { type AuthVariables, requireAuth } from "../middleware/require-auth.ts";
import { validate } from "../validate.ts";

const storyParamsSchema = z.object({
  storyId: z.string().uuid("storyId must be a valid UUID"),
});
const targetSchema = z.object({
  kind: z.enum(["topic", "entity"]),
  label: z.string().trim().min(1, "target label is required").max(MAXIMUM_INTEREST_LABEL_LENGTH),
}).strict();
const feedbackBodySchema = z.discriminatedUnion("action", [
  z.object({
    digestStoryId: z.string().uuid("digestStoryId must be a valid UUID"),
    action: z.enum(["relevant", "not_relevant", "already_known", "too_repetitive"]),
    target: z.never().optional(),
  }).strict(),
  z.object({
    digestStoryId: z.string().uuid("digestStoryId must be a valid UUID"),
    action: z.enum(["follow_topic", "show_less_topic", "mute_topic"]),
    target: targetSchema,
  }).strict(),
]);

export function buildStoryFeedbackRoutes(
  database: Database,
): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  routes.use("*", requireAuth(database));

  routes.post("/stories/:storyId/feedback", async (context) => {
    const { storyId } = validate(storyParamsSchema, context.req.param());
    const input = validate(feedbackBodySchema, await context.req.json());
    const result = await submitStoryFeedback(database, {
      ...input,
      storyId,
      userId: context.var.userId,
    });
    return context.json(result, 200);
  });

  return routes;
}
