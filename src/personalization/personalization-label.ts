import { z } from "zod";

export const MAXIMUM_PERSONALIZATION_LABEL_LENGTH = 200;

export const personalizationLabelSchema = z.string()
  .trim()
  .min(1)
  .max(MAXIMUM_PERSONALIZATION_LABEL_LENGTH);

/**
 * Normalizes model- or database-supplied label collections for delivery.
 * Invalid legacy/model labels are omitted instead of making the whole story unreadable.
 */
export const personalizationLabelsSchema = z.array(z.string()).transform((labels) => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    const parsed = personalizationLabelSchema.safeParse(label);
    if (!parsed.success) continue;
    const identity = parsed.data.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(parsed.data);
  }
  return normalized;
});
