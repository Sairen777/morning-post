import { createSignal, For, Show } from "solid-js";
import type { PublicFeed, FeedKind, RelevanceFilterOverride } from "../api/types";
import { ApiClientError } from "../api/client";
import FormatTime from "./FormatTime";

interface FeedsPanelProps {
  feeds: PublicFeed[];
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

  const feedsBySource = () => {
    const map: Record<string, PublicFeed[]> = {};
    for (const f of props.feeds) {
      if (!map[f.sourceId]) map[f.sourceId] = [];
      map[f.sourceId].push(f);
    }
    return map;
  };

  const sourceIds = () => Object.keys(feedsBySource());

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
    <div class="card">
      <div class="card-header">
        <h2>Feeds</h2>
      </div>
      <Show
        when={sourceIds().length > 0}
        fallback={<p style="padding: 1rem;">No subscribed feeds yet. Discover and subscribe in the Sources tab.</p>}
      >
        <For each={sourceIds()}>
          {(sourceId) => (
            <div style="margin-bottom: 1rem;">
              <h3 class="section-title">Source: {sourceId}</h3>
              <For each={feedsBySource()[sourceId]}>
                {(feed) => (
                  <div class="card" style="margin-bottom: 0.5rem;">
                    <div class="meta-row">
                      <dt>Name</dt>
                      <dd>{feed.name}</dd>
                    </div>
                    <div class="meta-row">
                      <dt>Kind</dt>
                      <dd>{feed.kind}</dd>
                    </div>
                    <div class="meta-row">
                      <dt>External ID</dt>
                      <dd style="font-family: monospace; font-size: 0.75rem;">
                        {feed.externalId}
                      </dd>
                    </div>
                    <Show when={feed.lastFetchedPeriodEndMs !== null}>
                      <div class="meta-row">
                        <dt>Last fetched</dt>
                        <dd>
                          <FormatTime ms={feed.lastFetchedPeriodEndMs!} />
                        </dd>
                      </div>
                    </Show>
                    <Show when={feed.customPrompt}>
                      <div class="meta-row">
                        <dt>Custom prompt</dt>
                        <dd class="hint">Set</dd>
                      </div>
                    </Show>

                    <div class="form-row" style="align-items: center; margin: 0.5rem 0;">
                      <label class="toggle">
                        <input
                          type="checkbox"
                          checked={feed.enabled}
                          onChange={(e) => handleToggle(feed.id, e.currentTarget.checked)}
                        />
                        <span>Enabled</span>
                      </label>
                    </div>
                    <div class="form-group" style="margin-top: 0.75rem;">
                      <label for={`feed-policy-${feed.id}`}>Relevance filtering</label>
                      <select
                        id={`feed-policy-${feed.id}`}
                        aria-label={`Relevance filtering for ${feed.name}`}
                        value={feed.relevanceFilterMode}
                        disabled={updatingPolicy()[feed.id]}
                        onChange={(e) =>
                          handlePolicyChange(
                            feed.id,
                            e.currentTarget.value as RelevanceFilterOverride,
                          )}
                      >
                        <option value="inherit">Inherit source/profile setting</option>
                        <option value="personalized">Personalized</option>
                        <option value="include_all">Include all</option>
                      </select>
                      <div class="hint">
                        Inherit follows the source override, then your profile setting.
                      </div>
                    </div>

                    <div class="form-row" style="gap: 0.5rem; margin: 0.5rem 0;">
                      <button
                        onClick={() => handleLoad(feed.id)}
                        disabled={loadingFeed()[feed.id]}
                      >
                        {loadingFeed()[feed.id] ? "Loading…" : "Load details"}
                      </button>
                      <button
                        onClick={() => handleUnsubscribe(feed.id)}
                        disabled={unsubscribing()[feed.id]}
                      >
                        {unsubscribing()[feed.id] ? "Unsubscribing…" : "Unsubscribe"}
                      </button>
                    </div>

                    <Show when={editingFeed()[feed.id] && feedEdits()[feed.id]}>
                      <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border);">
                        <div class="form-group">
                          <label>Kind</label>
                          <select
                            value={feedEdits()[feed.id].kind}
                            onChange={(e) =>
                              setFeedEdits((edits) => ({
                                ...edits,
                                [feed.id]: { ...edits[feed.id], kind: e.currentTarget.value as FeedKind },
                              }))
                            }
                          >
                            <option value="news">News</option>
                            <option value="discussion">Discussion</option>
                          </select>
                        </div>
                        <div class="form-group">
                          <label>Position</label>
                          <input
                            type="number"
                            value={feedEdits()[feed.id].position}
                            onInput={(e) =>
                              setFeedEdits((edits) => ({
                                ...edits,
                                [feed.id]: { ...edits[feed.id], position: e.currentTarget.value },
                              }))
                            }
                            placeholder="Auto"
                          />
                        </div>
                        <div class="form-group">
                          <label>Custom prompt</label>
                          <textarea
                            value={feedEdits()[feed.id].customPrompt}
                            onInput={(e) =>
                              setFeedEdits((edits) => ({
                                ...edits,
                                [feed.id]: { ...edits[feed.id], customPrompt: e.currentTarget.value },
                              }))
                            }
                            placeholder="No custom prompt"
                            rows={3}
                          />
                        </div>
                        <button
                          onClick={() => handleSave(feed.id)}
                          disabled={savingFeed()[feed.id]}
                          class="primary"
                        >
                          {savingFeed()[feed.id] ? "Saving…" : "Save feed"}
                        </button>
                      </div>
                    </Show>

                    <Show when={errors()[feed.id]}>
                      <div class="error">{errors()[feed.id]}</div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
