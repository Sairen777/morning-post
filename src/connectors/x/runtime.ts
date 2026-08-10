import type { AvailableFeed } from "../connector.types.ts";
import { abortReason, throwIfAborted } from "./abort.ts";
import {
  navigateXControl,
  XBrowserSessions,
} from "./browser-session.ts";
import type {
  XOwnedBrowserSession,
  XUnmanagedBrowserSession,
} from "./browser-session.ts";
import { resolveXTargetOnPage } from "./collection.ts";
import { inspectXConnectionState } from "./connection-state.ts";
import { parseXTargetUrl } from "./targets.ts";
import type {
  XBrowserChannel,
  XBrowserRuntimeOptions,
  XHeadedLoginHandle,
  XLoginState,
} from "./x.types.ts";
import { XConnector } from "./x-connector.ts";

const DEFAULT_LEASE_TIMEOUT_MS = 15_000;
const MAX_LEASE_TIMEOUT_MS = 300_000;

export class XVerificationRecoveryError extends Error {
  constructor(
    readonly control: "home" | "messages",
    options?: ErrorOptions,
  ) {
    super("X verification requires manual recovery", options);
    this.name = "XVerificationRecoveryError";
  }
}

export class XBrowserRuntime {
  private readonly sessions: XBrowserSessions;
  private readonly browserChannel: XBrowserChannel;

  constructor(options: XBrowserRuntimeOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("X browser runtime options are required");
    }
    const leaseTimeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    if (
      !Number.isFinite(leaseTimeoutMs) ||
      leaseTimeoutMs <= 0 ||
      leaseTimeoutMs > MAX_LEASE_TIMEOUT_MS
    ) {
      throw new Error(`X profile lease timeout must be between 1 and ${MAX_LEASE_TIMEOUT_MS} milliseconds`);
    }
    const browserChannel = options.browserChannel ?? "chrome";
    if (browserChannel !== "chromium" && browserChannel !== "chrome") {
      throw new Error('X browser channel must be "chromium" or "chrome"');
    }
    this.browserChannel = browserChannel;
    this.sessions = new XBrowserSessions(
      options.profileRoot,
      leaseTimeoutMs,
      this.browserChannel,
      options.chromeExecutable,
      options.chromeProcessLauncher,
    );
  }

  public async startHeadedLogin(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XHeadedLoginHandle> {
    this.sessions.validateProfileId(profileId);
    if (this.browserChannel === "chrome") {
      const session = await this.sessions.openUnmanaged(profileId, "home", signal);
      return new UnmanagedLoginHandle(this.sessions, profileId, session, signal);
    }
    const session = await this.sessions.openHeaded(profileId, signal);
    try {
      await navigateXControl(session.page, "home", signal);
      return new HeadedLoginHandle(session, this.sessions, profileId);
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  public async inspectConnectionState(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XLoginState> {
    this.sessions.validateProfileId(profileId);
    return await this.sessions.withHeadless(profileId, signal, async ({ page }) => {
      return await inspectXConnectionState(page, signal);
    });
  }

  public createConnector(profileId: string): XConnector {
    this.sessions.validateProfileId(profileId);
    return new XConnector(this.sessions, profileId);
  }

  public async resolveTarget(
    profileId: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<AvailableFeed> {
    this.sessions.validateProfileId(profileId);
    const target = parseXTargetUrl(url);
    return await this.sessions.withHeadless(profileId, signal, async ({ page }) => {
      return await resolveXTargetOnPage(page, target, signal);
    });
  }

  public async deleteProfile(profileId: string, signal?: AbortSignal): Promise<void> {
    this.sessions.validateProfileId(profileId);
    await this.sessions.removeProfile(profileId, signal);
  }

  public async disconnectProfile<T>(
    profileId: string,
    mutation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.sessions.validateProfileId(profileId);
    return await this.sessions.disconnectProfile(profileId, mutation, signal);
  }
}

export class UnmanagedLoginHandle implements XHeadedLoginHandle {
  private closed = false;
  private state: XLoginState = "awaiting_login";
  private readonly session: XUnmanagedBrowserSession;
  private visibleSession: XOwnedBrowserSession | undefined;
  private operation: Promise<XLoginState> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly sessions: Pick<XBrowserSessions, "openHeaded">,
    private readonly profileId: string,
    session: XUnmanagedBrowserSession,
    private readonly lifecycleSignal?: AbortSignal,
    private readonly inspector = inspectXConnectionState,
  ) {
    this.session = session;
  }

  public verify(signal?: AbortSignal): Promise<XLoginState> {
    try {
      throwIfAborted(this.lifecycleSignal);
      throwIfAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closed) {
      return Promise.reject(new Error("X headed login session is closed"));
    }
    if (this.visibleSession !== undefined) {
      if (!this.visibleSession.context.isClosed()) {
        return Promise.resolve(this.state);
      }
      this.visibleSession = undefined;
    }
    if (this.session.running) return Promise.resolve(this.state);
    this.operation ??= this.verifyAfterExit(signal).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async verifyAfterExit(signal?: AbortSignal): Promise<XLoginState> {
    const operationSignal = signal ?? this.lifecycleSignal;
    await this.session.waitForExit();
    throwIfAborted(operationSignal);
    const visibleSession = await this.sessions.openHeaded(
      this.profileId,
      operationSignal,
    );
    if (this.closed) {
      await visibleSession.close();
      throw new Error("X headed login session is closed");
    }
    this.visibleSession = visibleSession;

    try {
      this.state = await this.inspector(
        visibleSession.page,
        operationSignal,
      );
    } catch (error) {
      if (operationSignal?.aborted) {
        this.visibleSession = undefined;
        await visibleSession.close();
        throw abortReason(operationSignal);
      }
      let control: "home" | "messages" = "home";
      try {
        const path = new URL(visibleSession.page.url()).pathname;
        control = path === "/i/chat" || path.startsWith("/i/chat/")
          ? "messages"
          : "home";
      } catch {
        control = "home";
      }
      this.state = control === "messages"
        ? "awaiting_chat_unlock"
        : "awaiting_login";
      if (this.closed) {
        this.visibleSession = undefined;
        await visibleSession.close();
        throw error;
      }
      throw new XVerificationRecoveryError(control, { cause: error });
    }

    if (this.state === "complete") {
      this.visibleSession = undefined;
      await visibleSession.close();
    }
    return this.state;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise !== undefined) return this.closePromise;
    const closePromise = (async () => {
      const visibleSession = this.visibleSession;
      this.visibleSession = undefined;
      try {
        await Promise.all([
          this.session.close(),
          visibleSession?.close() ?? Promise.resolve(),
        ]);
        this.closed = true;
      } catch (error) {
        if (visibleSession !== undefined) this.visibleSession = visibleSession;
        throw error;
      } finally {
        if (!this.closed) this.closePromise = undefined;
      }
    })();
    this.closePromise = closePromise;
    return closePromise;
  }
}

export class HeadedLoginHandle implements XHeadedLoginHandle {
  private closed = false;
  private session: XOwnedBrowserSession;

  constructor(
    session: XOwnedBrowserSession,
    private readonly sessions: Pick<XBrowserSessions, "openHeaded">,
    private readonly profileId: string,
    private readonly inspector = inspectXConnectionState,
  ) {
    this.session = session;
  }

  public async verify(signal?: AbortSignal): Promise<XLoginState> {
    if (this.closed) {
      throw new Error("X headed login session is closed");
    }
    if (this.session.context.isClosed()) {
      this.session = await this.sessions.openHeaded(this.profileId, signal);
    }
    try {
      return await this.inspector(this.session.page, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      try {
        await this.session.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "X verification failed and its browser could not be closed",
        );
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.session.close();
    this.closed = true;
  }
}
