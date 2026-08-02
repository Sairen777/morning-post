import { z } from "zod";
import { ConnectorId } from "../constants.ts";
import { ValidationError } from "../server/errors.ts";
import type { XCredentials } from "./x/x.types.ts";
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

/** Upper bound (16 KiB) for a full X `Cookie` header value. */
export const X_COOKIE_MAX_LENGTH = 16 * 1024;

interface ParsedXCookiePairs {
  values: Map<string, string>;
  duplicateRequiredNames: Set<string>;
}

/** Parses a Cookie header value into name/value pairs without rewriting it. */
function parseXCookiePairs(cookie: string): ParsedXCookiePairs {
  const values = new Map<string, string>();
  const duplicateRequiredNames = new Set<string>();
  for (const rawPair of cookie.split(";")) {
    const separatorIndex = rawPair.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = rawPair.slice(0, separatorIndex).trim();
    let value = rawPair.slice(separatorIndex + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name.length === 0) {
      continue;
    }
    if (
      (name === "auth_token" || name === "ct0") &&
      values.has(name)
    ) {
      duplicateRequiredNames.add(name);
    }
    values.set(name, value);
  }
  return { values, duplicateRequiredNames };
}

/** Full X `Cookie` header value: required, trimmed of outer whitespace,
 * bounded to 16 KiB, and structurally validated (nonempty `auth_token` and
 * `ct0` pairs). The cookie contents are never rewritten, only checked. */
export const xCookieSchema = z.string().trim().min(
  1,
  "cookie is required",
).max(
  X_COOKIE_MAX_LENGTH,
  "cookie is too long",
).superRefine((value, context) => {
  const parsed = parseXCookiePairs(value);
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cookie must not contain control characters",
    });
  }
  for (const name of parsed.duplicateRequiredNames) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `cookie must contain exactly one ${name} pair`,
    });
  }
  const cookieAuthToken = parsed.values.get("auth_token");
  if (cookieAuthToken === undefined || cookieAuthToken.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cookie must contain a nonempty auth_token pair",
    });
  }
  const ct0 = parsed.values.get("ct0");
  if (ct0 === undefined || ct0.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cookie must contain a nonempty ct0 pair",
    });
  }
});

/**
 * Shared object-level refinement: the cookie's `auth_token` pair must equal
 * the separately provided `authToken`. Error messages never contain either
 * value.
 */
export function requireXCookieAuthTokenMatch(
  credentials: { cookie: string; authToken: string },
  context: z.RefinementCtx,
): void {
  const cookieAuthToken = parseXCookiePairs(credentials.cookie).values.get(
    "auth_token",
  );
  if (
    cookieAuthToken !== undefined &&
    cookieAuthToken !== credentials.authToken
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cookie auth_token does not match authToken",
    });
  }
}

export const xCredentialSchema: z.ZodType<XCredentials> = z.object({
  apiKey: z.string().min(1, "apiKey is required"),
  authToken: z.string().min(1, "authToken is required"),
  cookie: xCookieSchema,
  pin: z.string().min(1, "pin must not be empty").optional(),
  listQuery: z.string().min(1, "listQuery is required"),
  xUserId: z.string().min(1, "xUserId is required"),
  xUsername: z.string().min(1, "xUsername is required"),
}).strict().superRefine(requireXCookieAuthTokenMatch);

export type TelegramCredentials = z.infer<typeof telegramCredentialSchema>;
export type SubstackCredentials = z.infer<typeof substackCredentialSchema>;
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
