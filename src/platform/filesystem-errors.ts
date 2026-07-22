export function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
