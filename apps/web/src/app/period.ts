export function validateDigestPeriod(
  start: string,
  end: string,
):
  | { valid: true; body: { periodStartMs?: number; periodEndMs?: number } }
  | { valid: false; error: string } {
  const startBlank = start.trim() === "";
  const endBlank = end.trim() === "";

  // Both blank: let the backend compute the period.
  if (startBlank && endBlank) {
    return { valid: true, body: {} };
  }

  // Exactly one blank: block.
  if (startBlank !== endBlank) {
    return { valid: false, error: "Choose both period dates or leave both blank" };
  }

  // Both filled: convert to epoch ms and validate ordering.
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  if (startMs > endMs) {
    return { valid: false, error: "Period start must be before period end" };
  }

  return { valid: true, body: { periodStartMs: startMs, periodEndMs: endMs } };
}
