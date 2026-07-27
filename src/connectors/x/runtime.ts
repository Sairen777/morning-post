import type { AvailableFeed } from "../connector.types.ts";
import { abortReason } from "./abort.ts";
import {
  navigateXControl,
  XBrowserSessions,
} from "./browser-session.ts";
import type { XOwnedBrowserSession } from "./browser-session.ts";
import { resolveXTargetOnPage } from "./collection.ts";
import { inspectXConnectionState } from "./connection-state.ts";
import { parseXTargetUrl } from "./targets.ts";
import type {
  XBrowserRuntimeOptions,
  XHeadedLoginHandle,
  XLoginState,
} from "./x.types.ts";
import { XConnector } from "./x-connector.ts";

const DEFAULT_LEASE_TIMEOUT_MS = 15_000;
const MAX_LEASE_TIMEOUT_MS = 300_000;

export class XBrowserRuntime {
  private readonly sessions: XBrowserSessions;

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
    this.sessions = new XBrowserSessions(options.profileRoot, leaseTimeoutMs);
  }

  public async startHeadedLogin(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<XHeadedLoginHandle> {
    this.sessions.validateProfileId(profileId);
    const session = await this.sessions.openHeaded(profileId, signal);
    try {
      await navigateXControl(session.page, "home", signal);
      return new HeadedLoginHandle(session);
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

class HeadedLoginHandle implements XHeadedLoginHandle {
  private closed = false;

  constructor(private readonly session: XOwnedBrowserSession) {}

  public async verify(signal?: AbortSignal): Promise<XLoginState> {
    if (this.closed || this.session.context.isClosed()) {
      throw new Error("X headed login session is closed");
    }
    try {
      return await inspectXConnectionState(this.session.page, signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    await this.session.close();
    this.closed = true;
  }
}
