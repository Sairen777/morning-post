const SQLITE_UNIQUE_CODES: Record<string, true> = {
  SQLITE_CONSTRAINT_PRIMARYKEY: true,
  SQLITE_CONSTRAINT_UNIQUE: true,
};
const SQLITE_UNIQUE_ERRNOS: Record<number, true> = { 1555: true, 2067: true };

/**
 * Checks Bun SQLite errors (including Drizzle-wrapped causes) for the extended
 * result codes that specifically identify primary-key or unique constraints.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;
    if (
      (typeof candidate.code === "string" && candidate.code in SQLITE_UNIQUE_CODES)
      || (typeof candidate.errno === "number" && candidate.errno in SQLITE_UNIQUE_ERRNOS)
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
