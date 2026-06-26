/**
 * Produces a short, safe error message for operational records.
 *
 * Never includes stack traces, Drizzle SQL parameters, or raw runtime
 * details. Useful for persisting digest-run feed-row error messages
 * that are intended for an operator-facing audit view, not end users.
 *
 * Public HTTP error handling in src/server/errors.ts uses a similar
 * strategy for 500 responses but is not replaced by this helper.
 */
export function summarizeErrorForOps(error: unknown): string {
  const raw = error instanceof Error ? error.message.split("\nparams:")[0] : String(error);
  return raw.length > 500 ? raw.slice(0, 497) + "..." : raw;
}
