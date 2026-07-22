import type { Context } from "hono";
import { sanitizeErrorForOps } from "./error-sanitizer.ts";
export type StatusCode = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500;

export class AppError extends Error {
  constructor(
    public statusCode: StatusCode,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(422, message);
  }
}

export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body too large") {
    super(413, message);
  }
}

function codeFromStatus(statusCode: StatusCode): string {
  const map: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
  };
  return map[statusCode] ?? "ERROR";
}

export function errorHandler(error: Error, context: Context): Response {
  if (error instanceof AppError) {
    return context.json(
      {
        error: {
          code: codeFromStatus(error.statusCode),
          message: error.message,
        },
      },
      error.statusCode,
    );
  }

  // Malformed JSON bodies throw SyntaxError from c.req.json().
  if (error instanceof SyntaxError) {
    return context.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Malformed request body",
        },
      },
      400,
    );
  }

  const message = sanitizeErrorForOps(error);
  const name = error instanceof Error ? sanitizeErrorForOps(error.name) : "Error";
  console.error(`${name}: ${message}`);
  // Unknown errors — never leak internals.
  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    },
    500,
  );
}

