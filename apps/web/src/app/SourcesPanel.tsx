import { createSignal, For, Show } from "solid-js";
import type {
  PublicSource,
  PublicFeed,
  AvailableFeed,
  DisconnectSourceResponse,
  RelevanceFilterOverride,
} from "../api/types";
import { ApiClientError } from "../api/client";
import ServiceIcon from "./ServiceIcon";

interface SourcesPanelProps {
  sources: PublicSource[];
  feeds: PublicFeed[];
  availableFeeds: Record<string, AvailableFeed[]>;
  sourceFeeds: Record<string, PublicFeed[]>;
  onToggleSource: (id: string, enabled: boolean) => Promise<void>;
  onUpdateSourcePosition: (id: string, position: number | null) => Promise<void>;
  onUpdateSource?: (
    id: string,
    input: {
      relevanceFilterMode?: RelevanceFilterOverride;
    },
  ) => Promise<void>;
  onDisconnectSource: (id: string) => Promise<DisconnectSourceResponse>;
  onDiscoverFeeds: (sourceId: string) => Promise<AvailableFeed[]>;
  onLoadSourceFeeds: (sourceId: string) => Promise<PublicFeed[]>;
  onSubscribe: (sourceId: string, feed: AvailableFeed) => Promise<void>;
  onAuthError: () => void;
  onNavigateToConnections?: () => void;
}

function isSubscribed(
  feeds: PublicFeed[],
  sourceId: string,
  externalId: string,
): boolean {
  return feeds.some(
    (f) =>
      f.sourceId === sourceId &&
      f.externalId === externalId &&
      f.deletedAt === null,
  );
}

const connectorLabels: Record<string, string> = {
  feed: "RSS",
  reddit: "Reddit",
  rss: "RSS",
  substack: "Substack",
  telegram: "Telegram",
  twitter: "X",
  x: "X",
  youtube: "YouTube",
};

function connectorLabel(connectorId: string): string {
  const normalized = connectorId.trim().toLowerCase();
  return (
    connectorLabels[normalized] ??
    connectorId
      .trim()
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

function sourceContribution(connectorId: string): string {
  switch (connectorId.trim().toLowerCase()) {
    case "reddit":
      return "Communities and discussions from your account, ready to become a concise briefing.";
    case "rss":
    case "feed":
      return "Articles from the publications and feeds you choose to follow.";
    case "substack":
      return "The Substack publications you follow or add to your reading list.";
    case "telegram":
      return "Channels and discussions from your connected Telegram account.";
    case "twitter":
    case "x":
      return "Profiles and lists you choose to monitor for timely updates.";
    case "youtube":
      return "Channels you follow, turned into a focused reading queue.";
    default:
      return "Publications and channels from this connected service, shaped into your digest.";
  }
}

function policyLabel(mode: RelevanceFilterOverride): string {
  switch (mode) {
    case "personalized":
      return "Personalized";
    case "include_all":
      return "All stories";
    default:
      return "Profile setting";
  }
}

function feedKindLabel(kind: AvailableFeed["kind"]): string {
  return kind === "discussion" ? "Discussion" : "News";
}

export default function SourcesPanel(props: SourcesPanelProps) {
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal<
    Record<string, Record<string, boolean>>
  >({});
  const [positionInputs, setPositionInputs] = createSignal<Record<string, string>>({});
  const [disconnectResults, setDisconnectResults] = createSignal<Record<string, DisconnectSourceResponse>>({});
  const [discoveryState, setDiscoveryState] = createSignal<
    Record<string, "loaded" | "empty">
  >({});
  const [sourceFeedLoadState, setSourceFeedLoadState] = createSignal<
    Record<string, "loaded" | "empty">
  >({});

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
    setLoading((l) => ({
      ...l,
      [sourceId]: { ...l[sourceId], [key]: true },
    }));
  };

  const clearLoading = (sourceId: string, key: string) => {
    setLoading((l) => {
      const sourceLoading = l[sourceId];
      if (!sourceLoading) return l;
      const nextSourceLoading = { ...sourceLoading };
      delete nextSourceLoading[key];
      const next = { ...l };
      if (Object.keys(nextSourceLoading).length === 0) {
        delete next[sourceId];
      } else {
        next[sourceId] = nextSourceLoading;
      }
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
    setLoadingKey(id, "toggle");
    try {
      await props.onToggleSource(id, enabled);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(id, err.message);
      }
    } finally {
      clearLoading(id, "toggle");
    }
  };

  const handlePolicyChange = async (
    sourceId: string,
    relevanceFilterMode: RelevanceFilterOverride,
  ) => {
    const updateSource = props.onUpdateSource;
    if (!updateSource) return;
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "policy");
    try {
      await updateSource(sourceId, { relevanceFilterMode });
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId, "policy");
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
      clearLoading(sourceId, "position");
    }
  };

  const handleDiscover = async (sourceId: string) => {
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "discover");
    try {
      const discovered = await props.onDiscoverFeeds(sourceId);
      setDiscoveryState((state) => ({
        ...state,
        [sourceId]: discovered.length > 0 ? "loaded" : "empty",
      }));
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId, "discover");
    }
  };

  const handleLoadFeeds = async (sourceId: string) => {
    clearSourceError(sourceId);
    setLoadingKey(sourceId, "loadFeeds");
    try {
      const loaded = await props.onLoadSourceFeeds(sourceId);
      setSourceFeedLoadState((state) => ({
        ...state,
        [sourceId]: loaded.length > 0 ? "loaded" : "empty",
      }));
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId, "loadFeeds");
    }
  };

  const handleSubscribe = async (sourceId: string, feed: AvailableFeed) => {
    clearSourceError(sourceId);
    const loadingKey = `subscribe-${feed.externalId}`;
    setLoadingKey(sourceId, loadingKey);
    try {
      await props.onSubscribe(sourceId, feed);
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(sourceId, err.message);
      }
    } finally {
      clearLoading(sourceId, loadingKey);
    }
  };

  const handleDisconnect = async (source: PublicSource) => {
    const label = connectorLabel(source.connectorId);
    if (
      !confirm(
        `Disconnect ${label}? Existing subscriptions from this source will be removed from your digest.`,
      )
    ) {
      return;
    }
    clearSourceError(source.id);
    setLoadingKey(source.id, "disconnect");
    try {
      const result = await props.onDisconnectSource(source.id);
      setDisconnectResults((d) => ({ ...d, [source.id]: result }));
    } catch (err: unknown) {
      if (is401(err)) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setSourceError(source.id, err.message);
      }
    } finally {
      clearLoading(source.id, "disconnect");
    }
  };

  const connectedCount = () => props.sources.filter((source) => source.connected).length;
  const enabledCount = () => props.sources.filter((source) => source.enabled).length;
  const subscriptionCount = () =>
    props.feeds.filter((feed) => feed.deletedAt === null).length;

  return (
    <section class="sources-page" aria-labelledby="sources-page-title">
      <header class="sources-page-header">
        <div class="sources-page-intro">
          <p class="app-content-kicker">Your reading desk</p>
          <h2 id="sources-page-title">Sources</h2>
          <p>
            Choose the accounts and publications that supply your digest. Start
            with a connected source, then discover the feeds worth following.
          </p>
        </div>
        <dl class="source-overview-stats" aria-label="Source overview">
          <div>
            <dt>Connected</dt>
            <dd>{connectedCount()}</dd>
          </div>
          <div>
            <dt>Enabled</dt>
            <dd>{enabledCount()}</dd>
          </div>
          <div>
            <dt>Subscriptions</dt>
            <dd>{subscriptionCount()}</dd>
          </div>
        </dl>
      </header>

      <Show
        when={props.sources.length > 0}
        fallback={
          <div class="source-empty" role="status">
            <p class="source-empty-kicker">No sources connected</p>
            <h3>Your digest needs a place to begin.</h3>
            <p>
              Connect a service first. Once it is connected, return here to
              choose the publications or channels that should shape your
              briefings.
            </p>
            <Show when={props.onNavigateToConnections}>
              <button
                class="primary"
                type="button"
                onClick={() => props.onNavigateToConnections?.()}
              >
                Connect a source
              </button>
            </Show>
          </div>
        }
      >
        <div class="source-list">
          <For each={props.sources}>
            {(source) => {
              initPosition(source);
              const label = () => connectorLabel(source.connectorId);
              const posVal = () => positionInputs()[source.id] ?? "";
              const sourceFeedsList = () => props.sourceFeeds[source.id] ?? [];
              const availableFeedsList = () => props.availableFeeds[source.id] ?? [];
              const disconnectResult = () => disconnectResults()[source.id];
              const sourceSubscriptionCount = () =>
                props.feeds.filter(
                  (feed) => feed.sourceId === source.id && feed.deletedAt === null,
                ).length;
              const isLoading = (key: string) => loading()[source.id]?.[key] === true;
              const sourceError = () => errors()[source.id];
              const feedLoadState = () => sourceFeedLoadState()[source.id];
              const discoveryResult = () => discoveryState()[source.id];
              const canDiscover =
                source.connectorId !== "Substack" && source.connectorId !== "X";

              return (
                <article class="source-card">
                  <header class="source-card-header">
                    <div class="source-identity">
                      <span class="source-icon-wrap">
                        <ServiceIcon
                          connectorId={source.connectorId}
                          size={28}
                          title={`${label()} service`}
                        />
                      </span>
                      <div>
                        <p class="source-card-kicker">Connected source</p>
                        <h3>{label()}</h3>
                        <p class="source-contribution">
                          {sourceContribution(source.connectorId)}
                        </p>
                      </div>
                    </div>
                    <span
                      class={
                        source.connected
                          ? "badge badge-success"
                          : "badge badge-failed"
                      }
                    >
                      {source.connected ? "Connected" : "Reconnect needed"}
                    </span>
                  </header>

                  <dl class="source-summary">
                    <div>
                      <dt>Connection</dt>
                      <dd>{source.connected ? "Ready to use" : "Needs attention"}</dd>
                    </div>
                    <div>
                      <dt>Digest status</dt>
                      <dd>
                        <label class="toggle source-toggle">
                          <input
                            type="checkbox"
                            checked={source.enabled}
                            disabled={!source.connected || isLoading("toggle")}
                            aria-label={`Use ${label()} in digests`}
                            onChange={(e) =>
                              handleToggle(source.id, e.currentTarget.checked)
                            }
                          />
                          <span>
                            {source.enabled ? "Enabled" : "Not included"}
                          </span>
                        </label>
                      </dd>
                    </div>
                    <div>
                      <dt>Relevance</dt>
                      <dd>{policyLabel(source.relevanceFilterMode)}</dd>
                    </div>
                    <div>
                      <dt>Subscriptions</dt>
                      <dd>
                        {sourceSubscriptionCount()}{" "}
                        {sourceSubscriptionCount() === 1 ? "feed" : "feeds"}
                      </dd>
                    </div>
                  </dl>

                  <Show when={!source.connected}>
                    <p class="source-connection-note" role="note">
                      Reconnect this source from Connections before enabling it
                      or discovering feeds.
                    </p>
                  </Show>

                  <section class="source-discovery" aria-labelledby={`source-discovery-${source.id}`}>
                    <div class="source-section-heading">
                      <div>
                        <p class="source-card-kicker">Build your reading list</p>
                        <h4 id={`source-discovery-${source.id}`}>
                          {canDiscover ? "Discover feeds" : "Manage publications"}
                        </h4>
                        <p>
                          {canDiscover
                            ? "Find the publications or channels this source can contribute to your next digest."
                            : "Manage followed publications for this service in Connections."}
                        </p>
                      </div>
                      <Show
                        when={canDiscover}
                        fallback={
                          <p class="source-discovery-note">
                            Publication selection for this service is managed
                            in Connections.
                          </p>
                        }
                      >
                        <button
                          class="primary source-discover-button"
                          type="button"
                          onClick={() => handleDiscover(source.id)}
                          disabled={!source.connected || isLoading("discover")}
                        >
                          {isLoading("discover")
                            ? "Discovering…"
                            : "Discover feeds"}
                        </button>
                      </Show>
                    </div>

                    <Show when={canDiscover}>
                      <Show when={availableFeedsList().length > 0}>
                        <ul class="available-feed-list">
                          <For each={availableFeedsList()}>
                            {(availableFeed) => {
                              const subscribed = () =>
                                isSubscribed(
                                  props.feeds,
                                  source.id,
                                  availableFeed.externalId,
                                );
                              const subscribeLoadingKey = `subscribe-${availableFeed.externalId}`;
                              return (
                                <li class="available-feed-row">
                                  <div class="available-feed-copy">
                                    <h5>{availableFeed.name}</h5>
                                    <span>{feedKindLabel(availableFeed.kind)}</span>
                                  </div>
                                  <button
                                    class={
                                      subscribed()
                                        ? "source-subscribe source-subscribed"
                                        : "primary source-subscribe"
                                    }
                                    type="button"
                                    disabled={
                                      subscribed() ||
                                      isLoading(subscribeLoadingKey)
                                    }
                                    aria-label={
                                      subscribed()
                                        ? `Subscribed to ${availableFeed.name}`
                                        : `Subscribe to ${availableFeed.name}`
                                    }
                                    onClick={() =>
                                      handleSubscribe(source.id, availableFeed)
                                    }
                                  >
                                    {subscribed()
                                      ? "Subscribed"
                                      : isLoading(subscribeLoadingKey)
                                        ? "Subscribing…"
                                        : "Subscribe"}
                                  </button>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </Show>
                      <Show
                        when={
                          availableFeedsList().length === 0 &&
                          discoveryResult() === "empty"
                        }
                      >
                        <p class="source-discovery-empty" role="status">
                          No feeds were found yet. Check that this account has
                          accessible publications or channels, then try
                          Discover feeds again.
                        </p>
                      </Show>
                      <Show
                        when={
                          availableFeedsList().length === 0 &&
                          discoveryResult() === undefined
                        }
                      >
                        <p class="source-discovery-empty">
                          Select Discover feeds to load the publications and
                          channels available from this source.
                        </p>
                      </Show>
                    </Show>
                  </section>

                  <details class="source-advanced">
                    <summary>Source settings and maintenance</summary>
                    <div class="source-advanced-content">
                      <section class="source-settings" aria-labelledby={`source-policy-${source.id}`}>
                        <p class="source-card-kicker">Filtering</p>
                        <h4 id={`source-policy-${source.id}`}>Relevance policy</h4>
                        <label for={`source-policy-select-${source.id}`}>
                          How should this source be filtered?
                        </label>
                        <select
                          id={`source-policy-select-${source.id}`}
                          aria-label={`Relevance filtering for ${label()}`}
                          aria-describedby={`source-policy-hint-${source.id}`}
                          value={source.relevanceFilterMode}
                          disabled={isLoading("policy") || !props.onUpdateSource}
                          onChange={(e) =>
                            handlePolicyChange(
                              source.id,
                              e.currentTarget.value as RelevanceFilterOverride,
                            )
                          }
                        >
                          <option value="inherit">Follow profile setting</option>
                          <option value="personalized">Personalized</option>
                          <option value="include_all">Include all</option>
                        </select>
                        <p id={`source-policy-hint-${source.id}`} class="hint">
                          Profile setting is the default. An override applies
                          to every feed from this source.
                        </p>
                      </section>

                      <section class="source-settings" aria-labelledby={`source-order-${source.id}`}>
                        <p class="source-card-kicker">Ordering</p>
                        <h4 id={`source-order-${source.id}`}>Manual order</h4>
                        <p class="hint">
                          Leave this blank to let the digest arrange sources
                          automatically.
                        </p>
                        <div class="source-order-row">
                          <label for={`source-position-${source.id}`}>
                            Position in digest
                          </label>
                          <div class="control-row">
                            <input
                              id={`source-position-${source.id}`}
                              type="number"
                              min="0"
                              placeholder="Automatic"
                              value={posVal()}
                              onInput={(e) =>
                                handlePositionChange(
                                  source.id,
                                  e.currentTarget.value,
                                )
                              }
                            />
                            <button
                              type="button"
                              onClick={() => handleSavePosition(source.id)}
                              disabled={isLoading("position")}
                            >
                              {isLoading("position")
                                ? "Saving…"
                                : "Save position"}
                            </button>
                          </div>
                        </div>
                      </section>

                      <section class="source-settings" aria-labelledby={`source-subscriptions-${source.id}`}>
                        <p class="source-card-kicker">Maintenance</p>
                        <h4 id={`source-subscriptions-${source.id}`}>
                          Subscribed feeds
                        </h4>
                        <p class="hint">
                          Reload this list only when you need to inspect the
                          source’s current subscriptions.
                        </p>
                        <button
                          type="button"
                          onClick={() => handleLoadFeeds(source.id)}
                          disabled={isLoading("loadFeeds")}
                        >
                          {isLoading("loadFeeds")
                            ? "Loading…"
                            : "Load subscribed feeds"}
                        </button>
                        <Show when={sourceFeedsList().length > 0}>
                          <ul class="subscribed-feed-list">
                            <For each={sourceFeedsList()}>
                              {(feed) => (
                                <li>
                                  <span>{feed.name}</span>
                                  <span>{feedKindLabel(feed.kind)}</span>
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                        <Show
                          when={
                            sourceFeedsList().length === 0 &&
                            feedLoadState() === "empty"
                          }
                        >
                          <p class="source-discovery-empty" role="status">
                            No subscriptions were returned. Discover a feed
                            above to start building this source.
                          </p>
                        </Show>
                      </section>

                      <section class="source-danger-zone" aria-labelledby={`source-disconnect-${source.id}`}>
                        <p class="source-card-kicker">Account access</p>
                        <h4 id={`source-disconnect-${source.id}`}>
                          Disconnect source
                        </h4>
                        <p>
                          Disconnecting removes this source and its
                          subscriptions from future digests. You can connect
                          it again from Connections.
                        </p>
                        <button
                          class="danger"
                          type="button"
                          onClick={() => handleDisconnect(source)}
                          disabled={isLoading("disconnect")}
                        >
                          {isLoading("disconnect")
                            ? "Disconnecting…"
                            : "Disconnect source"}
                        </button>
                        <Show when={disconnectResult()}>
                          <p class="source-disconnect-result" role="status">
                            {disconnectResult()!.message}
                          </p>
                          <Show when={disconnectResult()!.revokeTelegramSession}>
                            <p class="source-disconnect-result">
                              Source disconnected. Revoke the Telegram session
                              in Telegram -&gt; Devices.
                            </p>
                          </Show>
                        </Show>
                      </section>
                    </div>
                  </details>

                  <Show when={sourceError()}>
                    <div class="error source-error" role="alert">
                      {sourceError()}
                    </div>
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
