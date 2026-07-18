import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import { ValidationError } from "../server/errors.ts";
import { validateSessionCookieValue } from "./substack/session-client.ts";

export const telegramCredentialSchema = z.object({
  sessionString: z.string(),
}).strict();

const sessionCookieSchema = z.string().superRefine((value, context) => {
  try {
    validateSessionCookieValue(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid Substack session cookie value",
    });
  }
});

export const substackCredentialSchema = z.object({
  substackSessionId: sessionCookieSchema,
  connectSessionId: sessionCookieSchema.optional(),
}).strict();

export type TelegramCredentials = z.infer<typeof telegramCredentialSchema>;
export type SubstackCredentials = z.infer<typeof substackCredentialSchema>;
export type ConnectorCredentials = TelegramCredentials | SubstackCredentials;

export function credentialSchemaFor(connectorId: ConnectorId | string): z.ZodType<unknown> {
  switch (connectorId) {
    case ConnectorId.Telegram:
      return telegramCredentialSchema;
    case ConnectorId.Substack:
      return substackCredentialSchema;
    default:
      throw new ValidationError(`unsupported credential schema for connector: ${connectorId}`);
  }
}
