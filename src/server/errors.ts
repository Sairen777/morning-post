import type { Context } from "@hono/hono";

type StatusCode = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

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

function codeFromStatus(statusCode: StatusCode): string {
  const map: Record<number, string> = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
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

  const message = error instanceof Error ? error.message.split("\nparams:")[0] : String(error);
  console.error(`${error instanceof Error ? error.name : "Error"}: ${message}`);
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

