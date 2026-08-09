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

export const xCredentialSchema = z.object({
  profileId: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "profileId must be a canonical lowercase UUID",
  ),
}).strict();

export type TelegramCredentials = z.infer<typeof telegramCredentialSchema>;
export type SubstackCredentials = z.infer<typeof substackCredentialSchema>;
export type XCredentials = z.infer<typeof xCredentialSchema>;
export type ConnectorCredentials =
  | TelegramCredentials
  | SubstackCredentials
  | XCredentials;

export function credentialSchemaFor(connectorId: ConnectorId | string): z.ZodType<unknown> {
  switch (connectorId) {
    case ConnectorId.Telegram:
      return telegramCredentialSchema;
    case ConnectorId.Substack:
      return substackCredentialSchema;
    case ConnectorId.X:
      return xCredentialSchema;
    default:
      throw new ValidationError(`unsupported credential schema for connector: ${connectorId}`);
  }
}
