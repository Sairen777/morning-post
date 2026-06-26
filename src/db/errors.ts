export const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Checks whether `error` (or its `.cause`) carries a specific Postgres
 * SQLSTATE code, accounting for Drizzle's error-wrapping convention.
 */
export function hasPostgresCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const top = error as Record<string, unknown>;
  if (typeof top.code === "string" && top.code === code) {
    return true;
  }
  const cause = top.cause;
  if (typeof cause === "object" && cause !== null) {
    const causeObj = cause as Record<string, unknown>;
    return typeof causeObj.code === "string" && causeObj.code === code;
  }
  return false;
}

export function isUniqueViolation(error: unknown): boolean {
  return hasPostgresCode(error, POSTGRES_UNIQUE_VIOLATION);
}
