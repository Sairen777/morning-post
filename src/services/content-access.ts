import type { NormalizedItem } from "../connectors/connector.types.ts";

export function isInaccessiblePaidItem(payload: NormalizedItem): boolean {
  return payload.meta?.audience === "only_paid" &&
    payload.meta?.contentAccess === "preview";
}
