import { describe, it, expect } from "vitest";
import { validateDigestPeriod } from "../app/period";

describe("validateDigestPeriod", () => {
  it("returns valid with empty body when both inputs are blank", () => {
    const result = validateDigestPeriod("", "");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.body).toEqual({});
    }
  });

  it("returns valid with empty body when both inputs are whitespace", () => {
    const result = validateDigestPeriod("   ", "\t");
    expect(result.valid).toBe(true);
  });

  it("returns error when only start is provided", () => {
    const result = validateDigestPeriod("2024-01-01T00:00", "");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Choose both period dates or leave both blank");
    }
  });

  it("returns error when only end is provided", () => {
    const result = validateDigestPeriod("", "2024-01-01T00:00");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Choose both period dates or leave both blank");
    }
  });

  it("returns error when start is after end", () => {
    const result = validateDigestPeriod("2024-12-31T00:00", "2024-01-01T00:00");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Period start must be before period end");
    }
  });

  it("returns valid with epoch ms when both dates are valid", () => {
    const result = validateDigestPeriod("2024-01-01T00:00", "2024-01-02T00:00");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.body.periodStartMs).toBe(new Date("2024-01-01T00:00").getTime());
      expect(result.body.periodEndMs).toBe(new Date("2024-01-02T00:00").getTime());
    }
  });

  it("returns valid when start equals end", () => {
    const result = validateDigestPeriod("2024-06-15T12:00", "2024-06-15T12:00");
    expect(result.valid).toBe(true);
  });
});
