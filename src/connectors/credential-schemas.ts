import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import { ValidationError } from "../server/errors.ts";

export const telegramCredentialSchema = z.object({
  sessionString: z.string(),
});

export type TelegramCredentials = z.infer<typeof telegramCredentialSchema>;
export type ConnectorCredentials = TelegramCredentials;

export function credentialSchemaFor(connectorId: ConnectorId | string): z.ZodType<unknown> {
  switch (connectorId) {
    case ConnectorId.Telegram:
      return telegramCredentialSchema;
    default:
      throw new ValidationError(`unsupported credential schema for connector: ${connectorId}`);
  }
}
