import type {
  XHeadedLoginHandle,
  XLoginState,
} from "../connectors/x/index.ts";
import { XVerificationRecoveryError } from "../connectors/x/runtime.ts";
import { ConnectorId } from "../constants.ts";
import { CredentialCipher } from "../crypto/credential-cipher.ts";
import type { Database } from "../db/client.ts";
import {
  findSourceByConnectorId,
  upsertSourceCredentials,
} from "../repositories/source-repository.ts";
import { ConflictError, NotFoundError } from "../server/errors.ts";

const SAFE_START_ERROR = "X browser login failed";
const SAFE_VERIFICATION_ERROR = "X login verification failed";
const SAFE_RETRYABLE_VERIFICATION_ERROR =
  "X login verification failed; your dedicated browser profile was preserved, but no recovery window opened. Retry Verify to reopen it. Cancel only if you want to abandon this login and delete the uncommitted profile.";
const SAFE_HOME_RECOVERY_ERROR =
  "X authentication evidence could not be inspected; your dedicated Chrome profile was preserved and Chrome was reopened at X Home. Confirm the authenticated timeline is visible, fully quit Chrome (Cmd-Q on macOS), then Verify again or cancel this login.";
const SAFE_MESSAGES_RECOVERY_ERROR =
  "X Chat readiness could not be inspected; your dedicated Chrome profile was preserved and Chrome was reopened at X Messages. Complete any visible Chat setup or unlock, fully quit Chrome (Cmd-Q on macOS), then Verify again or cancel this login.";
const SAFE_PROFILE_CLEANUP_ERROR = "X browser profile cleanup failed";
const SAFE_BROWSER_CLOSE_ERROR = "X connected, but the login window could not be closed";

export type XLoginStatus =
  | "awaiting_login"
  | "awaiting_chat_unlock"
  | "complete"
  | "error"
  | "expired";

export interface XLoginSessionStatus {
  sessionId: string;
  status: XLoginStatus;
  expiresAtMs: number;
  error?: string;
}

export interface XLoginBrowserRuntime {
  startHeadedLogin(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XHeadedLoginHandle>;
  deleteProfile(profileId: string, signal?: AbortSignal): Promise<void>;
}

export type XLoginExpirationScheduler = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface XLoginSessionManagerDependencies {
  database: Database;
  credentialCipher: CredentialCipher;
  browserRuntime: XLoginBrowserRuntime;
  loginTimeoutMs: number;
  now?: () => number;
  scheduleExpiration?: XLoginExpirationScheduler;
}

interface XLoginSession {
  id: string;
  userId: string;
  profileId: string;
  status: XLoginStatus;
  expiresAtMs: number;
  error: string | null;
  handle: XHeadedLoginHandle | null;
  cancelExpiration: (() => void) | null;
  verification: Promise<XLoginSessionStatus> | null;
  lifecycleController: AbortController;
  commitStarted: boolean;
  preserveProfileOnFailure: boolean;
}

const scheduleExpiration: XLoginExpirationScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  unref?.call(timer);
  return () => clearTimeout(timer);
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("X login operation aborted");
}

export class XLoginSessionManager {
  readonly #database: Database;
  readonly #credentialCipher: CredentialCipher;
  readonly #browserRuntime: XLoginBrowserRuntime;
  readonly #loginTimeoutMs: number;
  readonly #now: () => number;
  readonly #scheduleExpiration: XLoginExpirationScheduler;
  readonly #sessions = new Map<string, XLoginSession>();
  readonly #startingUsers = new Set<string>();
  #disposed = false;

  constructor(dependencies: XLoginSessionManagerDependencies) {
    if (
      !Number.isInteger(dependencies.loginTimeoutMs) ||
      dependencies.loginTimeoutMs <= 0
    ) {
      throw new Error("loginTimeoutMs must be a positive integer");
    }
    this.#database = dependencies.database;
    this.#credentialCipher = dependencies.credentialCipher;
    this.#browserRuntime = dependencies.browserRuntime;
    this.#loginTimeoutMs = dependencies.loginTimeoutMs;
    this.#now = dependencies.now ?? Date.now;
    this.#scheduleExpiration = dependencies.scheduleExpiration ??
      scheduleExpiration;
  }

  async startLogin(
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    this.#assertActive();
    if (this.#startingUsers.has(userId)) {
      throw new ConflictError("an X login session is already active");
    }
    this.#startingUsers.add(userId);
    try {
      return await this.#startLoginReserved(userId, signal);
    } finally {
      this.#startingUsers.delete(userId);
    }
  }

  async #startLoginReserved(
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    this.#assertActive();
    await this.#removeTerminalSessionsForUser(userId);
    for (const existing of this.#sessions.values()) {
      if (existing.userId === userId && this.#isAwaiting(existing)) {
        throw new ConflictError("an X login session is already active");
      }
    }
    if (signal?.aborted) throw abortReason(signal);
    const existingSource = await findSourceByConnectorId(
      this.#database,
      userId,
      ConnectorId.X,
    );
    if (signal?.aborted) throw abortReason(signal);


    const session: XLoginSession = {
      id: crypto.randomUUID(),
      userId,
      profileId: userId,
      status: "awaiting_login",
      expiresAtMs: this.#now() + this.#loginTimeoutMs,
      error: null,
      handle: null,
      cancelExpiration: null,
      verification: null,
      lifecycleController: new AbortController(),
      commitStarted: false,
      preserveProfileOnFailure: existingSource?.connected === true,
    };
    this.#sessions.set(session.id, session);
    session.cancelExpiration = this.#scheduleExpiration(() => {
      void this.#expire(session).catch(() => {
        session.status = "error";
        session.error = SAFE_VERIFICATION_ERROR;
      });
    }, this.#loginTimeoutMs);

    const abortLaunch = () => {
      session.lifecycleController.abort(
        signal === undefined ? undefined : abortReason(signal),
      );
    };
    signal?.addEventListener("abort", abortLaunch, { once: true });
    if (signal?.aborted) abortLaunch();
    try {
      session.handle = await this.#browserRuntime.startHeadedLogin(
        session.profileId,
        session.lifecycleController.signal,
      );
      if (signal?.aborted) throw abortReason(signal);
      if (this.#now() >= session.expiresAtMs) {
        await this.#expire(session);
      }
    } catch {
      if (signal?.aborted) {
        const profileCleaned = await this.#cancelSession(session);
        if (profileCleaned) this.#sessions.delete(session.id);
        throw abortReason(signal);
      }
      if (session.status !== "expired") {
        await this.#markError(session, SAFE_START_ERROR);
      }
    } finally {
      signal?.removeEventListener("abort", abortLaunch);
    }

    return this.#toStatus(session);
  }

  async getStatus(
    sessionId: string,
    userId: string,
  ): Promise<XLoginSessionStatus> {
    this.#assertActive();
    const session = this.#findOwnedSession(sessionId, userId);
    await this.#expireIfNeeded(session);
    return this.#toStatus(session);
  }

  async verify(
    sessionId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    this.#assertActive();
    const session = this.#findOwnedSession(sessionId, userId);
    await this.#expireIfNeeded(session);
    if (!this.#isAwaiting(session)) return this.#toStatus(session);
    if (signal?.aborted) throw abortReason(signal);

    if (session.verification !== null) {
      throw new ConflictError("X login verification is already in progress");
    }
    const verificationSignal = signal === undefined
      ? session.lifecycleController.signal
      : AbortSignal.any([signal, session.lifecycleController.signal]);
    session.verification = this.#verifySession(
      session,
      verificationSignal,
    ).finally(() => {
      session.verification = null;
    });
    return await session.verification;
  }

  async cancel(sessionId: string, userId: string): Promise<void> {
    this.#assertActive();
    const session = this.#findOwnedSession(sessionId, userId);
    if (session.commitStarted && session.verification !== null) {
      await session.verification.catch(() => undefined);
    }
    if (session.status === "complete") {
      throw new ConflictError("X login has already completed");
    }
    const profileCleaned = await this.#cancelSession(session).catch(() => false);
    if (!profileCleaned) {
      throw new ConflictError(SAFE_PROFILE_CLEANUP_ERROR);
    }
    this.#sessions.delete(session.id);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const sessions = [...this.#sessions.values()];
    const results = await Promise.allSettled(
      sessions.map((session) => this.#cancelSession(session)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        this.#sessions.delete(sessions[index].id);
      }
    }
    if (
      results.some((result) =>
        result.status === "rejected" || !result.value
      )
    ) {
      throw new Error(SAFE_PROFILE_CLEANUP_ERROR);
    }
  }

  async #verifySession(
    session: XLoginSession,
    signal?: AbortSignal,
  ): Promise<XLoginSessionStatus> {
    const handle = session.handle;
    if (handle === null) {
      await this.#markError(session, SAFE_VERIFICATION_ERROR);
      return this.#toStatus(session);
    }

    let state: XLoginState;
    try {
      state = await handle.verify(signal);
    } catch (error) {
      if (signal?.aborted) {
        if (session.status === "expired") return this.#toStatus(session);
        throw abortReason(signal);
      }
      session.error = error instanceof XVerificationRecoveryError
        ? error.control === "messages"
          ? SAFE_MESSAGES_RECOVERY_ERROR
          : SAFE_HOME_RECOVERY_ERROR
        : SAFE_RETRYABLE_VERIFICATION_ERROR;
      return this.#toStatus(session);
    }

    if (signal?.aborted) {
      if (session.status === "expired") return this.#toStatus(session);
      throw abortReason(signal);
    }
    session.error = null;
    if (this.#now() >= session.expiresAtMs) {
      await this.#expire(session);
      return this.#toStatus(session);
    }
    if (state !== "complete") {
      session.status = state;
      return this.#toStatus(session);
    }

    try {
      if (
        signal?.aborted ||
        this.#sessions.get(session.id) !== session ||
        !this.#isAwaiting(session)
      ) {
        throw signal?.aborted
          ? abortReason(signal)
          : new Error("X login session was cancelled");
      }
      session.commitStarted = true;
      session.cancelExpiration?.();
      session.cancelExpiration = null;
      const encryptedCredentials = await this.#credentialCipher.encrypt(
        JSON.stringify({ profileId: session.profileId }),
        { userId: session.userId, connectorId: ConnectorId.X },
      );
      await upsertSourceCredentials(this.#database, {
        userId: session.userId,
        connectorId: ConnectorId.X,
        credentials: encryptedCredentials,
      });
      session.status = "complete";
      session.error = null;
      try {
        await this.#closeHandle(session);
      } catch {
        session.error = SAFE_BROWSER_CLOSE_ERROR;
      }
    } catch {
      if (signal?.aborted && !session.commitStarted) {
        if (session.status === "expired") return this.#toStatus(session);
        throw abortReason(signal);
      }
      await this.#markError(session, SAFE_VERIFICATION_ERROR);
    }
    return this.#toStatus(session);
  }

  async #expireIfNeeded(session: XLoginSession): Promise<void> {
    if (this.#isAwaiting(session) && this.#now() >= session.expiresAtMs) {
      await this.#expire(session);
    }
  }

  async #expire(session: XLoginSession): Promise<void> {
    if (!this.#isAwaiting(session) || session.commitStarted) return;
    session.lifecycleController.abort(new Error("X login session expired"));
    session.status = "expired";
    session.error = null;
    session.cancelExpiration?.();
    session.cancelExpiration = null;
    await this.#cleanupTerminalSession(session);
  }

  async #markError(session: XLoginSession, error: string): Promise<void> {
    session.status = "error";
    session.error = error;
    session.cancelExpiration?.();
    session.cancelExpiration = null;
    await this.#cleanupTerminalSession(session);
  }

  async #cancelSession(session: XLoginSession): Promise<boolean> {
    session.lifecycleController.abort(new Error("X login session cancelled"));
    if (session.commitStarted && session.verification !== null) {
      await session.verification.catch(() => undefined);
    }
    session.cancelExpiration?.();
    session.cancelExpiration = null;
    return await this.#cleanupTerminalSession(session);
  }

  async #cleanupTerminalSession(session: XLoginSession): Promise<boolean> {
    try {
      await this.#closeHandle(session);
    } catch {
      session.status = "error";
      session.error = SAFE_BROWSER_CLOSE_ERROR;
      return false;
    }
    return await this.#removeUncommittedProfile(session);
  }

  async #removeUncommittedProfile(session: XLoginSession): Promise<boolean> {
    if (session.status === "complete" || session.preserveProfileOnFailure) {
      return true;
    }
    try {
      await this.#browserRuntime.deleteProfile(session.profileId);
      return true;
    } catch {
      session.status = "error";
      session.error = SAFE_PROFILE_CLEANUP_ERROR;
      return false;
    }
  }

  async #closeHandle(session: XLoginSession): Promise<void> {
    const handle = session.handle;
    if (handle === null) return;
    await handle.close();
    session.handle = null;
  }

  async #removeTerminalSessionsForUser(userId: string): Promise<void> {
    const terminal = [...this.#sessions.values()].filter((session) =>
      session.userId === userId && !this.#isAwaiting(session)
    );
    for (const session of terminal) {
      const profileCleaned = await this.#cancelSession(session).catch(() =>
        false
      );
      if (!profileCleaned) {
        throw new ConflictError(SAFE_PROFILE_CLEANUP_ERROR);
      }
      this.#sessions.delete(session.id);
    }
  }

  #findOwnedSession(sessionId: string, userId: string): XLoginSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundError("X login session not found");
    }
    return session;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ConflictError("X login service is unavailable");
    }
  }

  #isAwaiting(session: XLoginSession): boolean {
    return session.status === "awaiting_login" ||
      session.status === "awaiting_chat_unlock";
  }

  #toStatus(session: XLoginSession): XLoginSessionStatus {
    return {
      sessionId: session.id,
      status: session.status,
      expiresAtMs: session.expiresAtMs,
      ...(session.error === null ? {} : { error: session.error }),
    };
  }
}
