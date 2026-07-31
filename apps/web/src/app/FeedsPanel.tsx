import { createSignal, For, Show } from "solid-js";
import type {
  PublicFeed,
  PublicSource,
  FeedKind,
  RelevanceFilterOverride,
  SummarizationMode,
} from "../api/types";
import { ApiClientError } from "../api/client";
import FormatTime from "./FormatTime";
import ServiceIcon from "./ServiceIcon";

interface FeedGroup {
  sourceId: string;
  source: PublicSource | undefined;
  feeds: PublicFeed[];
}

function connectorLabel(connectorId: string): string {
  const normalized = connectorId.trim().toLowerCase();
  const knownLabels: Record<string, string> = {
    feed: "RSS",
    rss: "RSS",
    substack: "Substack",
    telegram: "Telegram",
    twitter: "X",
    x: "X",
  };
  if (knownLabels[normalized]) return knownLabels[normalized];
  const words = normalized.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return "Unknown service";
  return words
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function kindLabel(kind: FeedKind): string {
  return kind === "discussion" ? "Discussion" : "News";
}

function relevanceLabel(mode: RelevanceFilterOverride): string {
  if (mode === "personalized") return "Personalized";
  if (mode === "include_all") return "Include all";
  return "Inherited";
}

function summaryLabel(mode: SummarizationMode): string {
  return mode === "thorough" ? "Thorough" : "Standard";
}

interface FeedsPanelProps {
  feeds: PublicFeed[];
  sources?: PublicSource[];
  onOpenSources?: () => void;
  onLoadFeed: (id: string) => Promise<PublicFeed>;
  onToggleFeed: (id: string, enabled: boolean) => Promise<void>;
  onUpdateFeed: (
    id: string,
    input: {
      kind?: FeedKind;
      customPrompt?: string | null;
      position?: number | null;
      enabled?: boolean;
      relevanceFilterMode?: RelevanceFilterOverride;
      summarizationMode?: SummarizationMode;
    },
  ) => Promise<void>;
  onUnsubscribeFeed: (id: string) => Promise<void>;
  onAuthError: () => void;
}

export default function FeedsPanel(props: FeedsPanelProps) {
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [loadingFeed, setLoadingFeed] = createSignal<Record<string, boolean>>({});
  const [editingFeed, setEditingFeed] = createSignal<Record<string, boolean>>({});
  const [savingFeed, setSavingFeed] = createSignal<Record<string, boolean>>({});
  const [unsubscribing, setUnsubscribing] = createSignal<Record<string, boolean>>({});
  const [feedEdits, setFeedEdits] = createSignal<
    Record<string, { kind: FeedKind; customPrompt: string; position: string }>
  >({});
  const [updatingPolicy, setUpdatingPolicy] = createSignal<Record<string, boolean>>({});
  const [summaryModeInputs, setSummaryModeInputs] = createSignal<
    Record<string, SummarizationMode>
  >({});
  const [updatingSummaryMode, setUpdatingSummaryMode] = createSignal<Record<string, boolean>>({});

  const feedGroups = () => {
    const sourceMap = new Map((props.sources ?? []).map((source) => [source.id, source]));
    const groups: FeedGroup[] = [];
    const groupsBySource = new Map<string, FeedGroup>();

    for (const feed of props.feeds) {
      let group = groupsBySource.get(feed.sourceId);
      if (!group) {
        group = {
          sourceId: feed.sourceId,
          source: sourceMap.get(feed.sourceId),
          feeds: [],
        };
        groupsBySource.set(feed.sourceId, group);
        groups.push(group);
      }
      group.feeds.push(feed);
    }
    return groups;
  };

  const groupConnectorId = (group: FeedGroup) => group.source?.connectorId ?? "unknown";
  const groupLabel = (group: FeedGroup) =>
    group.source ? connectorLabel(group.source.connectorId) : "Source unavailable";
  const groupStatus = (group: FeedGroup) =>
    group.source ? (group.source.connected ? "Connected" : "Disconnected") : "Unavailable";
  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await props.onToggleFeed(id, enabled);
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [id]: err.message }));
      }
    }
  };

  const handlePolicyChange = async (
    id: string,
    relevanceFilterMode: RelevanceFilterOverride,
  ) => {
    setUpdatingPolicy((p) => ({ ...p, [id]: true }));
    try {
      await props.onUpdateFeed(id, { relevanceFilterMode });
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [id]: err.message }));
      }
    } finally {
      setUpdatingPolicy((p) => ({ ...p, [id]: false }));
    }
  };

  const handleSummaryModeChange = async (
    id: string,
    summarizationMode: SummarizationMode,
  ) => {
    const previousMode =
      summaryModeInputs()[id] ??
      props.feeds.find((feed) => feed.id === id)?.summarizationMode ??
      "basic";
    setSummaryModeInputs((modes) => ({ ...modes, [id]: summarizationMode }));
    setUpdatingSummaryMode((updating) => ({ ...updating, [id]: true }));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      await props.onUpdateFeed(id, { summarizationMode });
    } catch (err: unknown) {
      setSummaryModeInputs((modes) => ({ ...modes, [id]: previousMode }));
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((current) => ({ ...current, [id]: err.message }));
      }
    } finally {
      setUpdatingSummaryMode((updating) => ({ ...updating, [id]: false }));
    }
  };

  const handleLoad = async (id: string) => {
    setLoadingFeed((l) => ({ ...l, [id]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });
    try {
      const feed = await props.onLoadFeed(id);
      setEditingFeed((e) => ({ ...e, [id]: true }));
      setFeedEdits((e) => ({
        ...e,
        [id]: {
          kind: feed.kind,
          customPrompt: feed.customPrompt ?? "",
          position: feed.position != null ? String(feed.position) : "",
        },
      }));
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [id]: err.message }));
      }
    } finally {
      setLoadingFeed((l) => ({ ...l, [id]: false }));
    }
  };

  const handleSave = async (id: string) => {
    const edit = feedEdits()[id];
    if (!edit) return;
    setSavingFeed((s) => ({ ...s, [id]: true }));
    try {
      await props.onUpdateFeed(id, {
        kind: edit.kind,
        customPrompt: edit.customPrompt.trim() === "" ? null : edit.customPrompt,
        position: edit.position.trim() === "" ? null : Number(edit.position),
      });
      setEditingFeed((e) => ({ ...e, [id]: false }));
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [id]: err.message }));
      }
    } finally {
      setSavingFeed((s) => ({ ...s, [id]: false }));
    }
  };

  const handleUnsubscribe = async (id: string) => {
    setUnsubscribing((u) => ({ ...u, [id]: true }));
    try {
      await props.onUnsubscribeFeed(id);
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [id]: err.message }));
      }
    } finally {
      setUnsubscribing((u) => ({ ...u, [id]: false }));
    }
  };

  return (
    <section class="feeds-panel" aria-labelledby="feeds-panel-title">
      <header class="feeds-panel-header">
        <div>
          <p class="app-content-kicker">Choose your reading list</p>
          <h2 id="feeds-panel-title">Feeds</h2>
          <p class="feeds-panel-intro">
            Connect a service, choose the sources you trust, then tune individual
            feeds here before you run a digest.
          </p>
        </div>
        <p class="feeds-panel-next hint">
          Your next step: keep the feeds that should shape your daily briefing.
        </p>
      </header>

      <Show
        when={feedGroups().length > 0}
        fallback={
          <div class="feeds-empty" role="status">
            <p class="app-content-kicker">Nothing selected yet</p>
            <h3>Choose sources for your first digest</h3>
            <p>
              Visit Sources after connecting a service to discover publications,
              channels, and lists. Subscribed feeds will appear here with the
              controls you need to keep your briefing focused.
            </p>
            <Show when={props.onOpenSources}>
              <button type="button" class="primary" onClick={() => props.onOpenSources?.()}>
                Open Sources
              </button>
            </Show>
          </div>
        }
      >
        <div class="feed-source-groups">
          <For each={feedGroups()}>
            {(group) => (
              <section
                class="feed-source-group"
                aria-labelledby={`feed-source-${group.sourceId}`}
              >
                <header class="feed-source-header">
                  <div class="feed-source-identity">
                    <ServiceIcon
                      connectorId={groupConnectorId(group)}
                      size={28}
                      title={`${groupLabel(group)} source`}
                    />
                    <div>
                      <p class="app-content-kicker">Source</p>
                      <h3 id={`feed-source-${group.sourceId}`}>{groupLabel(group)}</h3>
                    </div>
                  </div>
                  <div class="feed-source-meta">
                    <span
                      class={`badge ${
                        group.source?.connected ? "badge-success" : "badge-muted"
                      }`}
                    >
                      {groupStatus(group)}
                    </span>
                    <span class="feed-source-count">
                      {group.feeds.length} {group.feeds.length === 1 ? "feed" : "feeds"}
                    </span>
                  </div>
                </header>

                <Show when={!group.source}>
                  <p class="feed-source-notice">
                    This connection is no longer available. Your subscriptions remain
                    listed so you can review or remove them.
                  </p>
                </Show>

                <div class="feed-card-list">
                  <For each={group.feeds}>
                    {(feed) => (
                      <article class="feed-card">
                        <div class="feed-card-heading">
                          <div class="feed-card-title">
                            <h4>{feed.name}</h4>
                            <div class="feed-card-badges" aria-label="Feed status">
                              <span class="badge badge-muted">{kindLabel(feed.kind)}</span>
                              <span
                                class={`badge ${
                                  feed.enabled ? "badge-success" : "badge-muted"
                                }`}
                              >
                                {feed.enabled ? "Enabled" : "Paused"}
                              </span>
                              <Show when={feed.deletedAt !== null}>
                                <span class="badge badge-muted">Removed</span>
                              </Show>
                            </div>
                          </div>
                          <label class="feed-toggle">
                            <input
                              type="checkbox"
                              checked={feed.enabled}
                              aria-label={`${feed.enabled ? "Disable" : "Enable"} ${feed.name}`}
                              onChange={(e) =>
                                handleToggle(feed.id, e.currentTarget.checked)
                              }
                            />
                            <span>{feed.enabled ? "Enabled" : "Enable feed"}</span>
                          </label>
                        </div>

                        <dl class="feed-overview">
                          <div class="feed-overview-item">
                            <dt>Last fetched</dt>
                            <dd>
                              <Show
                                when={feed.lastFetchedPeriodEndMs !== null}
                                fallback={<span class="hint">Not fetched yet</span>}
                              >
                                <FormatTime ms={feed.lastFetchedPeriodEndMs!} />
                              </Show>
                            </dd>
                          </div>
                          <div class="feed-overview-item">
                            <dt>Summary depth</dt>
                            <dd>{summaryLabel(feed.summarizationMode)}</dd>
                          </div>
                          <div class="feed-overview-item">
                            <dt>Relevance</dt>
                            <dd>{relevanceLabel(feed.relevanceFilterMode)}</dd>
                          </div>
                        </dl>

                        <details class="feed-advanced">
                          <summary>Customize &amp; advanced</summary>
                          <div class="feed-advanced-body">
                            <p class="hint">
                              Adjust how this feed is classified, ordered, and summarized.
                              Changes apply the next time you run a digest.
                            </p>

                            <div class="feed-advanced-grid">
                              <div class="form-group">
                                <label for={`feed-policy-${feed.id}`}>
                                  Relevance policy
                                </label>
                                <select
                                  id={`feed-policy-${feed.id}`}
                                  aria-label={`Relevance policy for ${feed.name}`}
                                  value={feed.relevanceFilterMode}
                                  disabled={updatingPolicy()[feed.id]}
                                  onChange={(e) =>
                                    handlePolicyChange(
                                      feed.id,
                                      e.currentTarget.value as RelevanceFilterOverride,
                                    )}
                                >
                                  <option value="inherit">
                                    Inherit source/profile setting
                                  </option>
                                  <option value="personalized">Personalized</option>
                                  <option value="include_all">Include all</option>
                                </select>
                                <div class="hint">
                                  Inherit follows the source override, then your profile
                                  setting.
                                </div>
                              </div>

                              <div class="form-group">
                                <label for={`feed-summary-${feed.id}`}>
                                  Summary depth
                                </label>
                                <select
                                  id={`feed-summary-${feed.id}`}
                                  aria-label={`Summary depth for ${feed.name}`}
                                  aria-describedby={`feed-summary-hint-${feed.id}`}
                                  value={
                                    summaryModeInputs()[feed.id] ??
                                    feed.summarizationMode
                                  }
                                  disabled={updatingSummaryMode()[feed.id]}
                                  onChange={(e) =>
                                    handleSummaryModeChange(
                                      feed.id,
                                      e.currentTarget.value as SummarizationMode,
                                    )}
                                >
                                  <option value="basic">
                                    Standard — follow profile setting
                                  </option>
                                  <option value="thorough">
                                    Thorough — add more context
                                  </option>
                                </select>
                                <div id={`feed-summary-hint-${feed.id}`} class="hint">
                                  {(summaryModeInputs()[feed.id] ??
                                    feed.summarizationMode) === "thorough"
                                    ? "Thorough adds more context and nuance."
                                    : "Standard follows your profile story-detail setting."}
                                </div>
                              </div>
                            </div>

                            <div class="feed-advanced-reference">
                              <dt>External feed reference</dt>
                              <dd>{feed.externalId}</dd>
                            </div>

                            <div class="feed-advanced-actions">
                              <button
                                type="button"
                                onClick={() => handleLoad(feed.id)}
                                disabled={loadingFeed()[feed.id]}
                              >
                                {loadingFeed()[feed.id]
                                  ? "Loading details…"
                                  : "Load customization"}
                              </button>
                              <button
                                type="button"
                                class="danger"
                                onClick={() => handleUnsubscribe(feed.id)}
                                disabled={unsubscribing()[feed.id]}
                              >
                                {unsubscribing()[feed.id]
                                  ? "Unsubscribing…"
                                  : "Unsubscribe feed"}
                              </button>
                            </div>

                            <Show when={editingFeed()[feed.id] && feedEdits()[feed.id]}>
                              <div class="feed-edit-panel">
                                <h5>Feed customization</h5>
                                <div class="form-group">
                                  <label for={`feed-kind-${feed.id}`}>Kind</label>
                                  <select
                                    id={`feed-kind-${feed.id}`}
                                    value={feedEdits()[feed.id].kind}
                                    onChange={(e) =>
                                      setFeedEdits((edits) => ({
                                        ...edits,
                                        [feed.id]: {
                                          ...edits[feed.id],
                                          kind: e.currentTarget.value as FeedKind,
                                        },
                                      }))
                                    }
                                  >
                                    <option value="news">News</option>
                                    <option value="discussion">Discussion</option>
                                  </select>
                                </div>
                                <div class="form-group">
                                  <label for={`feed-position-${feed.id}`}>
                                    Manual position
                                  </label>
                                  <input
                                    id={`feed-position-${feed.id}`}
                                    type="number"
                                    value={feedEdits()[feed.id].position}
                                    onInput={(e) =>
                                      setFeedEdits((edits) => ({
                                        ...edits,
                                        [feed.id]: {
                                          ...edits[feed.id],
                                          position: e.currentTarget.value,
                                        },
                                      }))
                                    }
                                    placeholder="Auto"
                                  />
                                </div>
                                <div class="form-group">
                                  <label for={`feed-prompt-${feed.id}`}>
                                    Custom prompt
                                  </label>
                                  <textarea
                                    id={`feed-prompt-${feed.id}`}
                                    value={feedEdits()[feed.id].customPrompt}
                                    onInput={(e) =>
                                      setFeedEdits((edits) => ({
                                        ...edits,
                                        [feed.id]: {
                                          ...edits[feed.id],
                                          customPrompt: e.currentTarget.value,
                                        },
                                      }))
                                    }
                                    placeholder="No custom prompt"
                                    rows={3}
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleSave(feed.id)}
                                  disabled={savingFeed()[feed.id]}
                                  class="primary"
                                >
                                  {savingFeed()[feed.id] ? "Saving…" : "Save feed"}
                                </button>
                              </div>
                            </Show>
                          </div>
                        </details>

                        <Show when={errors()[feed.id]}>
                          <div class="error" role="alert">
                            {errors()[feed.id]}
                          </div>
                        </Show>
                      </article>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
