import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  ApiClientError,
  addXTarget,
  cancelXLogin,
  getXLoginStatus,
  listAvailableFeeds,
  startXLogin,
  verifyXLogin,
} from "../api/client";
import type {
  AvailableFeed,
  PublicFeed,
  PublicSource,
  XLoginStatus,
  XLoginStatusResponse,
} from "../api/types";
import FormatTime from "./FormatTime";
import StatusBadge from "./StatusBadge";

interface XConnectPanelProps {
  sources: PublicSource[];
  feeds: PublicFeed[];
  onConnected: () => Promise<void>;
  onTargetAdded: (sourceId: string) => Promise<void>;
  onAuthError: () => void;
}

type Operation =
  | "start"
  | "refresh"
  | "verify"
  | "cancel"
  | "discover"
  | "target"
  | null;

const X_POLL_INTERVAL_MS = 2_000;
const X_LOGIN_SESSION_STORAGE_KEY = "morning-post.x-login-session-id";

function storedXLoginSessionId(): string | null {
  try {
    const value = globalThis.sessionStorage.getItem(
      X_LOGIN_SESSION_STORAGE_KEY,
    );
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function persistXLoginSessionId(value: string | null): void {
  try {
    if (value === null) {
      globalThis.sessionStorage.removeItem(X_LOGIN_SESSION_STORAGE_KEY);
    } else {
      globalThis.sessionStorage.setItem(X_LOGIN_SESSION_STORAGE_KEY, value);
    }
  } catch {
    // Storage can be unavailable in hardened browsers; polling still works
    // while this panel remains mounted.
  }
}

function isTerminalStatus(status: XLoginStatus | undefined): boolean {
  return status === "complete" || status === "error" || status === "expired";
}

function statusLabel(status: XLoginStatus | undefined): string {
  switch (status) {
    case "awaiting_login":
      return "Awaiting X login";
    case "awaiting_chat_unlock":
      return "Awaiting Chat unlock";
    case "complete":
      return "Connected";
    case "error":
      return "Connection error";
    case "expired":
      return "Login expired";
    default:
      return "Not started";
  }
}

function statusDescription(status: XLoginStatus | undefined): string {
  switch (status) {
    case "awaiting_login":
      return "Sign in to X and complete any 2FA in installed Chrome using Morning Post's dedicated profile, not your daily Chrome profile. When finished, fully quit Chrome before choosing Verify after Chrome quits. On macOS, press Cmd-Q; closing a tab or window is not enough.";
    case "awaiting_chat_unlock":
      return "Chrome has reopened at X Messages in Morning Post's dedicated profile. Unlock Chat, then fully quit Chrome before choosing Verify after Chrome quits. On macOS, press Cmd-Q; closing a tab or window is not enough.";
    case "complete":
      return "X is connected. Scheduled captures will run headlessly from Morning Post's dedicated profile.";
    case "error":
      return "The Chrome login session could not be verified. Start another session after fixing the issue in Morning Post's dedicated profile.";
    case "expired":
      return "The login window expired. Start another session to try again.";
    default:
      return "Start an installed Chrome login session using Morning Post's dedicated profile, not your daily Chrome profile.";
  }
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function isCanonicalXTargetUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "x.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }

    return (
      url.pathname === "/home" ||
      /^\/i\/lists\/[1-9]\d*$/.test(url.pathname) ||
      /^\/i\/chat\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function targetValidationMessage(value: string): string {
  if (!value.trim()) return "Enter an X target URL.";
  return "Use one canonical URL: https://x.com/home, https://x.com/i/lists/<numeric-id>, or https://x.com/i/chat/<safe-id>.";
}

const X_FOLLOWING_EXTERNAL_ID = "x:following";
const X_LIST_EXTERNAL_ID_PATTERN = /^x:list:([1-9]\d*)$/;
const X_CHAT_EXTERNAL_ID_PATTERN = /^x:chat:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

type XDiscoveredTarget = {
  feed: AvailableFeed;
  kind: "Following" | "List" | "Chat";
  url: string;
};

function xDiscoveredTarget(feed: AvailableFeed): XDiscoveredTarget | null {
  if (feed.externalId === X_FOLLOWING_EXTERNAL_ID) {
    return { feed, kind: "Following", url: "https://x.com/home" };
  }

  const listId = X_LIST_EXTERNAL_ID_PATTERN.exec(feed.externalId)?.[1];
  if (listId) {
    return {
      feed,
      kind: "List",
      url: `https://x.com/i/lists/${listId}`,
    };
  }

  const chatId = X_CHAT_EXTERNAL_ID_PATTERN.exec(feed.externalId)?.[1];
  if (chatId) {
    return { feed, kind: "Chat", url: `https://x.com/i/chat/${chatId}` };
  }

  return null;
}

export default function XConnectPanel(props: XConnectPanelProps) {
  const [sessionId, setSessionId] = createSignal<string | null>(
    storedXLoginSessionId(),
  );
  const [status, setStatus] = createSignal<XLoginStatusResponse | null>(null);
  const [operation, setOperation] = createSignal<Operation>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [targetUrl, setTargetUrl] = createSignal("");
  const [targetError, setTargetError] = createSignal<string | null>(null);
  const [targetNotice, setTargetNotice] = createSignal<string | null>(null);
  const [discoveryState, setDiscoveryState] = createSignal<
    "untouched" | "loading" | "loaded" | "empty" | "error"
  >("untouched");
  const [discoveredTargets, setDiscoveredTargets] = createSignal<
    XDiscoveredTarget[]
  >([]);
  const [discoveryError, setDiscoveryError] = createSignal<string | null>(null);
  const [discoveryNotice, setDiscoveryNotice] = createSignal<string | null>(
    null,
  );
  const [addingExternalId, setAddingExternalId] = createSignal<string | null>(
    null,
  );
  const [discoverySourceId, setDiscoverySourceId] = createSignal<string | null>(
    null,
  );

  let pollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let pollInFlight = false;
  let disposed = false;
  let completionNotifiedForSession: string | null = null;
  let discoveryGeneration = 0;

  const rememberSessionId = (value: string | null) => {
    persistXLoginSessionId(value);
    setSessionId(value);
  };

  const connectedSource = () =>
    props.sources.find(
      (source) => source.connectorId === "X" && source.connected,
    );
  const hasXSource = () =>
    props.sources.some((source) => source.connectorId === "X");

  const isDiscoveredTargetAdded = (target: XDiscoveredTarget) => {
    const sourceId = connectedSource()?.id;
    return (
      sourceId !== undefined &&
      props.feeds.some(
        (feed) =>
          feed.sourceId === sourceId &&
          feed.externalId === target.feed.externalId &&
          feed.deletedAt === null,
      )
    );
  };

  createEffect(() => {
    const sourceId = connectedSource()?.id ?? null;
    if (discoverySourceId() === sourceId) return;

    discoveryGeneration += 1;
    setDiscoverySourceId(sourceId);
    setDiscoveredTargets([]);
    setDiscoveryError(null);
    setDiscoveryNotice(null);
    setAddingExternalId(null);
  });
  const clearPollTimer = () => {
    if (pollTimer !== null) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const stopPolling = () => {
    clearPollTimer();
  };

  const applyStatus = (result: XLoginStatusResponse) => {
    setStatus(result);
    setError(result.error ?? null);
  };

  const notifyConnected = async (connectedSessionId: string) => {
    if (completionNotifiedForSession === connectedSessionId) return;
    completionNotifiedForSession = connectedSessionId;
    try {
      await props.onConnected();
    } catch (err: unknown) {
      setError(safeError(err, "X connected, but sources could not be refreshed."));
    }
  };

  const schedulePolling = () => {
    if (
      disposed ||
      pollTimer !== null ||
      !sessionId() ||
      isTerminalStatus(status()?.status)
    ) {
      return;
    }
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = null;
      void pollStatus();
    }, X_POLL_INTERVAL_MS);
  };

  const pollStatus = async () => {
    const currentSessionId = sessionId();
    if (!currentSessionId || pollInFlight || disposed) return;

    pollInFlight = true;
    try {
      const result = await getXLoginStatus(currentSessionId);
      if (disposed || sessionId() !== currentSessionId) return;
      applyStatus(result);
      if (result.status === "complete") {
        stopPolling();
        await notifyConnected(currentSessionId);
      } else if (isTerminalStatus(result.status)) {
        stopPolling();
      } else {
        schedulePolling();
      }
    } catch (err: unknown) {
      if (disposed || sessionId() !== currentSessionId) return;
      if (err instanceof ApiClientError && err.status === 404) {
        rememberSessionId(null);
        setStatus(null);
        setError(null);
        setNotice("The previous X login session is no longer active.");
        return;
      }
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "X login status could not be checked."));
      }
      schedulePolling();
    } finally {
      pollInFlight = false;
    }
  };

  const startPolling = () => {
    stopPolling();
    schedulePolling();
  };

  onMount(() => {
    if (sessionId() !== null) void pollStatus();
  });

  onCleanup(() => {
    disposed = true;
    stopPolling();
  });

  const handleStart = async () => {
    if (operation() !== null) return;
    stopPolling();
    rememberSessionId(null);
    setStatus(null);
    setError(null);
    setNotice(null);
    setOperation("start");
    try {
      const result = await startXLogin();
      persistXLoginSessionId(result.sessionId);
      if (disposed) return;
      completionNotifiedForSession = null;
      setSessionId(result.sessionId);
      applyStatus(result);
      if (result.status === "complete") {
        await notifyConnected(result.sessionId);
      } else if (isTerminalStatus(result.status)) {
        stopPolling();
      } else {
        startPolling();
      }
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "X login could not be started."));
      }
    } finally {
      setOperation(null);
    }
  };

  const handleRefresh = async () => {
    if (!sessionId() || operation() !== null) return;
    clearPollTimer();
    setOperation("refresh");
    try {
      await pollStatus();
    } finally {
      setOperation(null);
    }
  };

  const handleVerify = async () => {
    const currentSessionId = sessionId();
    if (!currentSessionId || operation() !== null) return;
    clearPollTimer();
    setError(null);
    setNotice(null);
    setOperation("verify");
    try {
      const result = await verifyXLogin(currentSessionId);
      if (disposed || sessionId() !== currentSessionId) return;
      applyStatus(result);
      if (result.status === "complete") {
        stopPolling();
        await notifyConnected(currentSessionId);
      } else if (isTerminalStatus(result.status)) {
        stopPolling();
      } else {
        schedulePolling();
      }
    } catch (err: unknown) {
      if (disposed || sessionId() !== currentSessionId) return;
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "X login could not be verified."));
      }
      schedulePolling();
    } finally {
      setOperation(null);
    }
  };

  const handleCancel = async () => {
    const currentSessionId = sessionId();
    if (!currentSessionId || operation() !== null) return;
    clearPollTimer();
    setOperation("cancel");
    try {
      await cancelXLogin(currentSessionId);
      if (storedXLoginSessionId() === currentSessionId) {
        persistXLoginSessionId(null);
      }
      if (disposed || sessionId() !== currentSessionId) return;
      setSessionId(null);
      setStatus(null);
      setError(null);
      setNotice("The X login session was canceled.");
      completionNotifiedForSession = null;
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "The X login session could not be canceled."));
      }
      schedulePolling();
    } finally {
      setOperation(null);
    }
  };

  const handleDiscoverFeeds = async () => {
    const source = connectedSource();
    if (!source || operation() !== null) return;

    const requestSourceId = source.id;
    const requestGeneration = discoveryGeneration;
    setDiscoveryError(null);
    setDiscoveryNotice(null);
    setDiscoveredTargets([]);
    setDiscoveryState("loading");
    setOperation("discover");
    try {
      const availableFeeds = await listAvailableFeeds(requestSourceId);
      if (
        requestGeneration !== discoveryGeneration ||
        connectedSource()?.id !== requestSourceId
      ) {
        return;
      }

      const targets: XDiscoveredTarget[] = [];
      for (const feed of availableFeeds) {
        const target = xDiscoveredTarget(feed);
        if (target) targets.push(target);
      }
      setDiscoveredTargets(targets);
      setDiscoveryState(targets.length > 0 ? "loaded" : "empty");
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        setDiscoveryState("error");
        props.onAuthError();
        return;
      }
      if (
        requestGeneration !== discoveryGeneration ||
        connectedSource()?.id !== requestSourceId
      ) {
        return;
      }
      setDiscoveryState("error");
      setDiscoveryError(safeError(err, "X feeds could not be discovered."));
    } finally {
      setOperation(null);
    }
  };

  const handleAddDiscoveredFeed = async (target: XDiscoveredTarget) => {
    const source = connectedSource();
    if (
      !source ||
      operation() !== null ||
      isDiscoveredTargetAdded(target)
    ) {
      return;
    }

    const requestSourceId = source.id;
    const requestGeneration = discoveryGeneration;
    setDiscoveryError(null);
    setDiscoveryNotice(null);
    setAddingExternalId(target.feed.externalId);
    setOperation("target");
    try {
      const feed = await addXTarget({
        sourceId: requestSourceId,
        url: target.url,
      });
      await props.onTargetAdded(requestSourceId);
      if (
        requestGeneration === discoveryGeneration &&
        connectedSource()?.id === requestSourceId
      ) {
        setDiscoveryNotice(`${feed.name} was added to your feeds.`);
      }
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
        return;
      }
      if (
        requestGeneration !== discoveryGeneration ||
        connectedSource()?.id !== requestSourceId
      ) {
        return;
      }
      setDiscoveryError(safeError(err, "That X feed could not be added."));
    } finally {
      setAddingExternalId(null);
      setOperation(null);
    }
  };

  const handleTargetSubmit = async (event: Event) => {
    event.preventDefault();
    if (operation() !== null) return;

    const value = targetUrl().trim();
    if (!isCanonicalXTargetUrl(value)) {
      setTargetError(targetValidationMessage(value));
      setTargetNotice(null);
      return;
    }
    const source = connectedSource();
    if (!source) {
      setTargetError("Connect and verify X before adding a target.");
      return;
    }

    setTargetError(null);
    setTargetNotice(null);
    setOperation("target");
    try {
      const feed = await addXTarget({
        sourceId: source.id,
        url: value,
      });
      const alreadyAdded = props.feeds.some(
        (existing) =>
          existing.sourceId === source.id &&
          existing.externalId === feed.externalId &&
          existing.deletedAt === null,
      );
      if (alreadyAdded) {
        setTargetNotice(`${feed.name} is already in your feeds.`);
        return;
      }
      setTargetUrl("");
      setTargetNotice(`${feed.name} was added to your feeds.`);
      await props.onTargetAdded(source.id);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setTargetError(safeError(err, "That X target could not be added."));
      }
    } finally {
      setOperation(null);
    }
  };

  const activeStatus = () => status()?.status;
  const canVerify = () =>
    activeStatus() === "awaiting_login" ||
    activeStatus() === "awaiting_chat_unlock";
  const canCancel = () =>
    sessionId() !== null && !isTerminalStatus(activeStatus());

  return (
    <div class="card">
      <div class="card-header">
        <h2>X Connection</h2>
      </div>

      <p class="hint x-connect-intro">
        X capture uses installed Chrome with a separate profile dedicated to
        Morning Post, not your daily Chrome profile. You never give Morning
        Post an X password, 2FA code, cookie, or session credential here.
      </p>

      <div class="x-connect-safety" role="note">
        <strong>Before connecting</strong>
        <ul class="bullet-list">
          <li>
            Start the dedicated Chrome login from this page. Morning Post opens
            installed Chrome with its separate profile on the same desktop where
            its service is running. That desktop must have a display; a remote
            or headless server cannot display this window for you. You can use
            this page in Safari or Firefox, but the login itself uses installed
            Chrome.
          </li>
          <li>
            Sign in and complete any 2FA manually in the dedicated Chrome
            profile. When finished, fully quit Chrome before choosing Verify
            after Chrome quits. On macOS, use Cmd-Q; closing a tab or window is
            not enough. If Chat unlock is required, Chrome will reopen at
            Messages with the next instructions.
          </li>
          <li>
            After verification, scheduled captures run headlessly from Morning
            Post's dedicated profile. Do not use your daily Chrome profile for
            this workflow. Browser collection is unsupported and brittle, and
            the profile grants full access to this X account.
          </li>
          <li>
            Captured disappearing messages are retained indefinitely, like the
            rest of the collector data.
          </li>
        </ul>
      </div>

      <Show when={sessionId() !== null}>
        <section
          class="x-connect-status"
          aria-labelledby="x-connect-status-title"
          aria-busy={operation() !== null}
        >
          <div class="x-connect-status-header">
            <h3 id="x-connect-status-title">Connection status</h3>
            <StatusBadge
              status={activeStatus() ?? "awaiting_login"}
              label={statusLabel(activeStatus())}
            />
          </div>
          <p class="hint" role="status" aria-live="polite">
            {statusDescription(activeStatus())}
          </p>
          <Show when={status()?.expiresAtMs !== undefined}>
            <div class="meta-row">
              <dt>Login window expires</dt>
              <dd><FormatTime ms={status()!.expiresAtMs} /></dd>
            </div>
          </Show>
          <div class="x-connect-actions">
            <Show when={!isTerminalStatus(activeStatus())}>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={operation() !== null}
              >
                {operation() === "refresh" ? "Refreshing…" : "Refresh status"}
              </button>
              <button
                type="button"
                class="primary"
                onClick={handleVerify}
                disabled={operation() !== null || !canVerify()}
              >
                {operation() === "verify" ? "Verifying after Chrome quits…" : "Verify after quitting Chrome"}
              </button>
              <button
                type="button"
                class="danger"
                onClick={handleCancel}
                disabled={operation() !== null || !canCancel()}
              >
                {operation() === "cancel" ? "Canceling…" : "Cancel"}
              </button>
            </Show>
            <Show when={isTerminalStatus(activeStatus())}>
              <button
                type="button"
                class="primary"
                onClick={handleStart}
                disabled={operation() !== null}
              >
                {operation() === "start"
                  ? "Starting Morning Post's dedicated Chrome profile…"
                  : hasXSource()
                  ? "Reconnect X with Morning Post's dedicated Chrome profile"
                  : "Connect X with Morning Post's dedicated Chrome profile"}
              </button>
            </Show>
          </div>
          <Show when={error()}>
            <p class="error" role="alert">{error()}</p>
          </Show>
        </section>
      </Show>

      <Show when={sessionId() === null}>
        <button
          type="button"
          class="primary"
          onClick={handleStart}
          disabled={operation() !== null}
        >
          {operation() === "start"
            ? "Starting Morning Post's dedicated Chrome profile…"
            : hasXSource()
            ? "Reconnect X with Morning Post's dedicated Chrome profile"
            : "Connect X with Morning Post's dedicated Chrome profile"}
        </button>
      </Show>

      <Show when={notice()}>
        <p class="hint" role="status" aria-live="polite">{notice()}</p>
      </Show>
      <Show when={error() && sessionId() === null}>
        <p class="error" role="alert">{error()}</p>
      </Show>

      <Show when={connectedSource()}>
        <section
          class="x-connect-target"
          aria-labelledby="x-connect-target-title"
        >
          <h3 id="x-connect-target-title">Add an X feed</h3>
          <p class="hint">
            Add Following, a selected List, or a selected X Chat conversation
            one at a time. The server checks the target again before it is
            added.
          </p>
          <section
            class="x-connect-discovery"
            aria-labelledby="x-connect-discovery-title"
            aria-busy={discoveryState() === "loading"}
          >
            <div class="substack-discovery-header">
              <div>
                <h3 id="x-connect-discovery-title">Discover X feeds</h3>
                <p class="hint">
                  Find safe Following, Lists, and Chat conversations available
                  in your connected X account.
                </p>
              </div>
              <button
                type="button"
                class="primary"
                onClick={handleDiscoverFeeds}
                disabled={operation() !== null}
              >
                {operation() === "discover"
                  ? "Discovering X feeds…"
                  : "Discover X feeds"}
              </button>
            </div>
            <Show when={discoveryState() === "loaded"}>
              <div class="publication-list" aria-label="Discovered X feeds">
                <For each={discoveredTargets()}>
                  {(target) => {
                    const feed = target.feed;
                    return (
                      <article class="publication-row">
                        <div class="publication-details">
                          <h4>{feed.name}</h4>
                          <div class="publication-domain">
                            {target.kind} · {target.url}
                          </div>
                        </div>
                        <Show
                          when={!isDiscoveredTargetAdded(target)}
                          fallback={
                            <button
                              type="button"
                              aria-label={`Added ${feed.name}`}
                              disabled
                            >
                              Added
                            </button>
                          }
                        >
                          <button
                            type="button"
                            class="publication-action"
                            aria-label={`${
                              addingExternalId() === feed.externalId
                                ? "Adding"
                                : "Add"
                            } ${feed.name}`}
                            disabled={operation() !== null}
                            onClick={() => handleAddDiscoveredFeed(target)}
                          >
                            {addingExternalId() === feed.externalId
                              ? "Adding…"
                              : "Add"}
                          </button>
                        </Show>
                      </article>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={discoveryState() === "empty"}>
              <p class="substack-discovery-empty" role="status">
                No safe X feeds were found in this account.
              </p>
            </Show>
            <Show when={discoveryNotice()}>
              <p class="hint" role="status" aria-live="polite">
                {discoveryNotice()}
              </p>
            </Show>
            <Show when={discoveryError()}>
              <p class="error" role="alert">{discoveryError()}</p>
            </Show>
          </section>

          <div class="x-connect-examples">
            <strong>Accepted canonical URLs</strong>
            <ul class="bullet-list">
              <li><code>https://x.com/home</code> — Following</li>
              <li><code>https://x.com/i/lists/&lt;numeric-id&gt;</code> — a List</li>
              <li><code>https://x.com/i/chat/&lt;safe-id&gt;</code> — an X Chat conversation</li>
            </ul>
          </div>
          <form onSubmit={handleTargetSubmit}>
            <div class="form-group">
              <label for="x-target-url">X target URL</label>
              <input
                id="x-target-url"
                type="url"
                autocomplete="off"
                placeholder="https://x.com/home"
                value={targetUrl()}
                onInput={(event) => setTargetUrl(event.currentTarget.value)}
                aria-describedby="x-target-help"
                required
              />
              <div id="x-target-help" class="hint">
                Use the canonical address copied from X. Query strings, hashes,
                alternate hosts, and other URLs are not accepted.
              </div>
            </div>
            <button
              type="submit"
              disabled={operation() !== null}
            >
              {operation() === "target" ? "Adding target…" : "Add X feed"}
            </button>
          </form>
          <Show when={targetNotice()}>
            <p class="hint" role="status" aria-live="polite">{targetNotice()}</p>
          </Show>
          <Show when={targetError()}>
            <p class="error" role="alert">{targetError()}</p>
          </Show>
        </section>
      </Show>
    </div>
  );
}
