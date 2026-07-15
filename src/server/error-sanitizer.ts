/**
 * Replace credentials and other transport secrets before an error message is
 * written to logs or persisted in an operational record.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk[-_]|xai-)[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bgsk_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

/**
 * Produces a short, safe error message for operational records and logs.
 *
 * Drizzle's query error includes bound values after a `\nparams:` marker.
 * Remove that section before applying the 500-character operational cap.
 */
export function sanitizeErrorForOps(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutParams = raw.split("\nparams:")[0];
  const redacted = redactSecrets(withoutParams);
  return redacted.length > 500 ? redacted.slice(0, 497) + "..." : redacted;
}

export function summarizeErrorForOps(error: unknown): string {
  return sanitizeErrorForOps(error);
}
