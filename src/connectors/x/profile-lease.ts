import { abortReason, throwIfAborted } from "./abort.ts";

const MAX_WAITERS_PER_PROFILE = 8;

interface ProfileWaiter {
  grant: () => boolean;
  fail: (error: Error) => void;
}

interface ProfileLeaseState {
  held: boolean;
  waiters: ProfileWaiter[];
}

// Deliberately module-shared: all runtime and connector instances in this process
// serialize access to the same persistent Chromium profile.
const profileLeases = new Map<string, ProfileLeaseState>();

export async function acquireProfileLease(
  profileKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => void> {
  throwIfAborted(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("X profile lease timeout must be a positive number");
  }

  const existing = profileLeases.get(profileKey);
  if (!existing) {
    profileLeases.set(profileKey, { held: true, waiters: [] });
    return createRelease(profileKey);
  }
  if (existing.waiters.length >= MAX_WAITERS_PER_PROFILE) {
    throw new Error("X browser profile is busy (wait queue is full)");
  }

  const { promise, resolve, reject } = Promise.withResolvers<() => void>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const removeWaiter = (waiter: ProfileWaiter) => {
    const index = existing.waiters.indexOf(waiter);
    if (index >= 0) existing.waiters.splice(index, 1);
  };
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const waiter: ProfileWaiter = {
    grant: () => {
      if (settled) return false;
      settled = true;
      cleanup();
      resolve(createRelease(profileKey));
      return true;
    },
    fail: (error) => {
      if (settled) return;
      settled = true;
      removeWaiter(waiter);
      cleanup();
      reject(error);
    },
  };
  const onAbort = () => waiter.fail(abortReason(signal));

  existing.waiters.push(waiter);
  timer = setTimeout(
    () => waiter.fail(new Error("Timed out waiting for the X browser profile")),
    timeoutMs,
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return await promise;
}

function createRelease(profileKey: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = profileLeases.get(profileKey);
    if (!state) return;

    while (state.waiters.length > 0) {
      const next = state.waiters.shift();
      if (next?.grant()) return;
    }
    state.held = false;
    profileLeases.delete(profileKey);
  };
}
