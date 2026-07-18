import { createSignal, For, Show } from "solid-js";
import type { PublicSource, PublicFeed, AvailableFeed, DisconnectSourceResponse } from "../api/types";
import { ApiClientError } from "../api/client";

interface SourcesPanelProps {
  sources: PublicSource[];
  feeds: PublicFeed[];
  availableFeeds: Record<string, AvailableFeed[]>;
  sourceFeeds: Record<string, PublicFeed[]>;
  onToggleSource: (id: string, enabled: boolean) => Promise<void>;
  onUpdateSourcePosition: (id: string, position: number | null) => Promise<void>;
  onDisconnectSource: (id: string) => Promise<DisconnectSourceResponse>;
  onDiscoverFeeds: (sourceId: string) => Promise<AvailableFeed[]>;
  onLoadSourceFeeds: (sourceId: string) => Promise<PublicFeed[]>;
  onSubscribe: (sourceId: string, feed: AvailableFeed) => Promise<void>;
  onAuthError: () => void;
}

function isSubscribed(
  feeds: PublicFeed[],
  sourceId: string,
  externalId: string,
): boolean {
  return feeds.some(
    (f) => f.sourceId === sourceId && f.externalId === externalId,
  );
}

export default function SourcesPanel(props: SourcesPanelProps) {
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal<Record<string, string>>({});
  const [positionInputs, setPositionInputs] = createSignal<Record<string, string>>({});
  const [disconnectResults, setDisconnectResults] = createSignal<Record<string, DisconnectSourceResponse>>({});

  const setSourceError = (sourceId: string, message: string) => {
    setErrors((e) => ({ ...e, [sourceId]: message }));
  };

  const clearSourceError = (sourceId: string) => {
    setErrors((e) => {
      const next = { ...e };
      delete next[sourceId];
      return next;
    });
  };

  const setLoadingKey = (sourceId: string, key: string) => {
    setLoading((l) => ({ ...l, [sourceId]: key }));
  };

  const clearLoading = (sourceId: string) => {
    setLoading((l) => {
      const next = { ...l };
      delete next[sourceId];
      return next;
    });
  };

  const initPosition = (source: PublicSource) => {
    setPositionInputs((p) => {
      if (!(source.id in p)) {
        return { ...p, [source.id]: source.position != null ? String(source.position) : "" };
      }
      return p;
    });
  };

  const handlePositionChange = (sourceId: string, value: string) => {
    setPositionInputs((p) => ({ ...p, [sourceId]: value }));
  };

  const is401 = (err: unknown): boolean => {
    return err instanceof ApiClientError && err.status === 401;
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    clearSourceError(id);
    try {
      await props.onToggleSource(id, enabled);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(id, err.message);
      }
    }
  };

  const handleSavePosition = async (sourceId: string) => {
    const raw = positionInputs()[sourceId] ?? "";
    const trimmed = raw.trim();
    const position = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && (isNaN(position as number) || position! < 0)) {
      setSourceError(sourceId, "Position must be a non-negative number or blank.");
      return;
    }
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "position");
    try {
      await props.onUpdateSourcePosition(sourceId, position);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId);
    }
  };

  const handleDiscover = async (sourceId: string) => {
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "discover");
    try {
      await props.onDiscoverFeeds(sourceId);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId);
    }
  };

  const handleLoadFeeds = async (sourceId: string) => {
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "loadFeeds");
    try {
      await props.onLoadSourceFeeds(sourceId);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId);
    }
  };

  const handleSubscribe = async (sourceId: string, feed: AvailableFeed) => {
    clearSourceError(sourceId);
    try {
      await props.onSubscribe(sourceId, feed);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    }
  };

  const handleDisconnect = async (sourceId: string) => {
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "disconnect");
    try {
      const result = await props.onDisconnectSource(sourceId);
      setDisconnectResults((d) => ({ ...d, [sourceId]: result }));
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Sources</h2>
      </div>
      <Show
        when={props.sources.length > 0}
        fallback={
          <p class="hint">
            Connectors are available through the existing Telegram login API;
            this screen displays connected sources once they exist.
          </p>
        }
      >
        <For each={props.sources}>
          {(source) => {
            initPosition(source);
            const posVal = () => positionInputs()[source.id] ?? "";
            const sourceFeedsList = () => props.sourceFeeds[source.id] ?? [];
            const availableFeedsList = () => props.availableFeeds[source.id] ?? [];
            const disconnectResult = () => disconnectResults()[source.id];
            const isLoading = (key: string) => loading()[source.id] === key;
            const sourceError = () => errors()[source.id];

            return (
              <div class="card" style="margin-bottom: 0.75rem;">
                {/* Connector and status */}
                <div class="meta-row">
                  <dt>Connector</dt>
                  <dd>{source.connectorId}</dd>
                </div>
                <div class="meta-row">
                  <dt>Connected</dt>
                  <dd>
                    <span class={source.connected ? "badge badge-success" : "badge badge-failed"}>
                      {source.connected ? "Connected" : "Disconnected"}
                    </span>
                  </dd>
                </div>
                <div class="meta-row">
                  <dt>Enabled</dt>
                  <dd>
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        disabled={!source.connected}
                        onChange={(e) =>
                          handleToggle(source.id, e.currentTarget.checked)
                        }
                      />
                      <span>{source.enabled ? "Enabled" : "Disabled"}</span>
                    </label>
                  </dd>
                </div>
                <Show when={!source.connected}>
                  <p class="hint" style="margin-top: 0.25rem;">
                    Reconnect this source from the Connections tab before enabling it.
                  </p>
                </Show>

                {/* Position */}
                <div class="form-group" style="margin-top: 0.75rem;">
                  <label style="display: block; margin-bottom: 0.25rem;">Position</label>
                  <div class="form-row">
                    <input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={posVal()}
                      onInput={(e) => handlePositionChange(source.id, e.currentTarget.value)}
                    />
                    <button
                      onClick={() => handleSavePosition(source.id)}
                      disabled={isLoading("position")}
                    >
                      {isLoading("position") ? "Saving…" : "Save position"}
                    </button>
                  </div>
                </div>

                {/* Load subscribed feeds */}
                <div style="margin-top: 0.5rem;">
                  <button
                    onClick={() => handleLoadFeeds(source.id)}
                    disabled={isLoading("loadFeeds")}
                  >
                    {isLoading("loadFeeds") ? "Loading…" : "Load subscribed feeds"}
                  </button>
                  <Show when={sourceFeedsList().length > 0}>
                    <div style="margin-top: 0.5rem;">
                      <For each={sourceFeedsList()}>
                        {(feed) => (
                          <div class="card" style="margin-bottom: 0.25rem; padding: 0.5rem;">
                            <div class="meta-row">
                              <dt>{feed.name}</dt>
                              <dd>{feed.kind}</dd>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                {/* Discover feeds */}
                <Show when={source.connectorId !== "Substack"}>
                <div style="margin-top: 0.5rem;">
                  <button
                    onClick={() => handleDiscover(source.id)}
                    disabled={isLoading("discover")}
                  >
                    {isLoading("discover") ? "Discovering…" : "Discover feeds"}
                  </button>
                  <Show when={availableFeedsList().length > 0}>
                    <div style="margin-top: 0.5rem;">
                      <For each={availableFeedsList()}>
                        {(af) => (
                          <div class="card" style="margin-bottom: 0.25rem; padding: 0.5rem;">
                            <div class="meta-row">
                              <dt>Name</dt>
                              <dd>{af.name}</dd>
                            </div>
                            <div class="meta-row">
                              <dt>Kind</dt>
                              <dd>{af.kind}</dd>
                            </div>
                            <button
                              onClick={() => handleSubscribe(source.id, af)}
                              disabled={isSubscribed(props.feeds, source.id, af.externalId)}
                              style="margin-top: 0.25rem;"
                            >
                              {isSubscribed(props.feeds, source.id, af.externalId)
                                ? "Subscribed"
                                : "Subscribe"}
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                </Show>
                {/* Disconnect */}
                <div style="margin-top: 0.75rem;">
                  <button
                    onClick={() => handleDisconnect(source.id)}
                    disabled={isLoading("disconnect")}
                  >
                    {isLoading("disconnect") ? "Disconnecting…" : "Disconnect source"}
                  </button>
                  <Show when={disconnectResult()}>
                    <div class="hint" style="margin-top: 0.5rem;">
                      {disconnectResult()!.message}
                    </div>
                    <Show when={disconnectResult()!.revokeTelegramSession}>
                      <div class="hint" style="margin-top: 0.25rem;">
                        Source disconnected. Revoke the Telegram session in Telegram -&gt; Devices.
                      </div>
                    </Show>
                  </Show>
                </div>

                {/* Error display */}
                <Show when={sourceError()}>
                  <div class="error" style="margin-top: 0.5rem;">
                    {sourceError()}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
