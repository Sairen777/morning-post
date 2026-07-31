export const LONG_REQUEST_IDLE_TIMEOUT_SECONDS = 255;

export function extendLongRequestTimeout(
  server: Pick<Bun.Server<undefined>, "timeout"> | undefined,
  request: Request,
): void {
  server?.timeout(request, LONG_REQUEST_IDLE_TIMEOUT_SECONDS);
}
