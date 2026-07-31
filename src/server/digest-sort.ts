import { z } from "zod";
import { ValidationError } from "./errors.ts";

/**
 * Digest list orderings. `requested_*` sorts by the digest request/creation
 * timestamp; `period_*` sorts by the coverage period end. `_desc`/`_asc`
 * select newest/largest first or oldest/smallest first.
 */
export const digestSorts = [
  "requested_desc",
  "requested_asc",
  "period_desc",
  "period_asc",
] as const;

export type DigestSort = (typeof digestSorts)[number];

export const digestSortSchema = z.enum(digestSorts);

/** Newest-requested first; the canonical digest list order. */
export const DEFAULT_DIGEST_SORT: DigestSort = "requested_desc";

export function parseDigestSort(raw: string | null | undefined): DigestSort {
  if (raw === null || raw === undefined) return DEFAULT_DIGEST_SORT;
  const parsed = digestSortSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`sort must be one of: ${digestSorts.join(", ")}`);
  }
  return parsed.data;
}
