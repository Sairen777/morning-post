import {
  AssertionError,
  deepStrictEqual,
  fail,
  notDeepStrictEqual,
} from "node:assert/strict";

type ErrorConstructor = abstract new (...args: never[]) => Error;

function withContext(message: string, context?: string): string {
  return context ? `${message}: ${context}` : message;
}

function validateThrown(
  error: unknown,
  ErrorClass?: ErrorConstructor,
  messageIncludes?: string,
  message?: string,
): Error {
  if (ErrorClass && !(error instanceof ErrorClass)) {
    throw new AssertionError({
      message: withContext(
        `Expected error to be an instance of ${ErrorClass.name}, but received ${error instanceof Error ? error.constructor.name : typeof error}`,
        message,
      ),
      actual: error,
      expected: ErrorClass,
      operator: "instanceof",
    });
  }

  if (messageIncludes !== undefined) {
    const actualMessage = error instanceof Error ? error.message : String(error);
    if (!actualMessage.includes(messageIncludes)) {
      throw new AssertionError({
        message: withContext(
          `Expected error message to include ${JSON.stringify(messageIncludes)}, but received ${JSON.stringify(actualMessage)}`,
          message,
        ),
        actual: actualMessage,
        expected: messageIncludes,
        operator: "includes",
      });
    }
  }

  return error as Error;
}

function errorExpectation(
  ErrorClassOrMessage?: ErrorConstructor | string,
  messageIncludes?: string,
  message?: string,
): [ErrorConstructor | undefined, string | undefined, string | undefined] {
  return typeof ErrorClassOrMessage === "string"
    ? [undefined, ErrorClassOrMessage, messageIncludes]
    : [ErrorClassOrMessage, messageIncludes, message];
}

export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) fail(message ?? "Expected value to be truthy");
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  deepStrictEqual(actual, expected, message);
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  notDeepStrictEqual(actual, expected, message);
}

export function assertStrictEquals<T>(actual: unknown, expected: T, message?: string): asserts actual is T {
  if (actual !== expected) {
    throw new AssertionError({
      message: message ?? "Values are not strictly equal",
      actual,
      expected,
      operator: "strictEqual",
    });
  }
}

export function assertExists<T>(actual: T, message?: string): asserts actual is NonNullable<T> {
  if (actual === null || actual === undefined) {
    throw new AssertionError({
      message: message ?? "Expected value to be neither null nor undefined",
      actual,
      expected: "non-nullish value",
      operator: "exists",
    });
  }
}

export function assertStringIncludes(actual: string, expected: string, message?: string): void {
  if (!actual.includes(expected)) {
    throw new AssertionError({
      message: message ?? `Expected string to include ${JSON.stringify(expected)}`,
      actual,
      expected,
      operator: "includes",
    });
  }
}

export function assertThrows(
  fn: () => unknown,
  ErrorClassOrMessage?: ErrorConstructor | string,
  messageIncludes?: string,
  message?: string,
): Error {
  const expectation = errorExpectation(ErrorClassOrMessage, messageIncludes, message);
  try {
    fn();
  } catch (error) {
    return validateThrown(error, ...expectation);
  }
  fail(withContext("Expected function to throw", expectation[2]));
}

export async function assertRejects(
  fn: () => PromiseLike<unknown>,
  ErrorClassOrMessage?: ErrorConstructor | string,
  messageIncludes?: string,
  message?: string,
): Promise<Error> {
  const expectation = errorExpectation(ErrorClassOrMessage, messageIncludes, message);
  try {
    await fn();
  } catch (error) {
    return validateThrown(error, ...expectation);
  }
  fail(withContext("Expected function to reject", expectation[2]));
}
