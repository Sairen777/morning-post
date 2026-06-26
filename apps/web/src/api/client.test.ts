import { describe, it, expect } from "vitest";
import { ApiClientError } from "../api/client";

describe("ApiClientError", () => {
  it("exposes status, code, and message", () => {
    const error = new ApiClientError(422, "VALIDATION_ERROR", "Bad input");
    expect(error.status).toBe(422);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("Bad input");
    expect(error.name).toBe("ApiClientError");
  });
});
