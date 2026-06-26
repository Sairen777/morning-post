import { For, Show } from "solid-js";
import type { PublicFeed, AvailableFeed } from "../api/types";

interface FeedsPanelProps {
  feeds: PublicFeed[];
  availableFeeds: Record<string, AvailableFeed[]>;
  onToggleFeed: (id: string, enabled: boolean) => Promise<void>;
  onSubscribe: (
    sourceId: string,
    feed: AvailableFeed,
  ) => Promise<void>;
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

export default function FeedsPanel(props: FeedsPanelProps) {
  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await props.onToggleFeed(id, enabled);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  const handleSubscribe = async (sourceId: string, feed: AvailableFeed) => {
    try {
      await props.onSubscribe(sourceId, feed);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  const feedsBySource = () => {
    const map: Record<string, PublicFeed[]> = {};
    for (const f of props.feeds) {
      if (!map[f.sourceId]) map[f.sourceId] = [];
      map[f.sourceId].push(f);
    }
    return map;
  };

  const sourceIds = () => Object.keys(feedsBySource());

  return (
    <div class="card">
      <div class="card-header">
        <h2>Feeds</h2>
      </div>
      <Show
        when={sourceIds().length > 0}
        fallback={<p class="hint">No feeds subscribed yet.</p>}
      >
        <For each={sourceIds()}>
          {(sourceId) => (
            <div style="margin-bottom: 1.5rem;">
              <h3 class="section-title">Source: {sourceId}</h3>
              <For each={feedsBySource()[sourceId]}>
                {(feed) => (
                  <div
                    class="card"
                    style="margin-bottom: 0.5rem; padding: 0.75rem;"
                  >
                    <div class="meta-row">
                      <dt>Name</dt>
                      <dd>{feed.name}</dd>
                    </div>
                    <div class="meta-row">
                      <dt>Kind</dt>
                      <dd>{feed.kind}</dd>
                    </div>
                    <div class="meta-row">
                      <dt>Enabled</dt>
                      <dd>
                        <label class="toggle">
                          <input
                            type="checkbox"
                            checked={feed.enabled}
                            onChange={(e) =>
                              handleToggle(feed.id, e.currentTarget.checked)
                            }
                          />
                          <span>{feed.enabled ? "On" : "Off"}</span>
                        </label>
                      </dd>
                    </div>
                    <Show when={feed.lastFetchedPeriodEndMs != null}>
                      <div class="meta-row">
                        <dt>Last fetched</dt>
                        <dd>
                          {new Date(feed.lastFetchedPeriodEndMs!).toLocaleString()}
                        </dd>
                      </div>
                    </Show>
                    <div class="meta-row">
                      <dt>Custom prompt</dt>
                      <dd>{feed.customPrompt ? "Yes" : "No"}</dd>
                    </div>
                  </div>
                )}
              </For>
              {/* Available feeds to subscribe */}
              <Show when={props.availableFeeds[sourceId]?.length > 0}>
                <h4 style="margin-top: 0.75rem; font-size: 0.9rem;">
                  Available to subscribe
                </h4>
                <For each={props.availableFeeds[sourceId]}>
                  {(af) => (
                    <div
                      class="card"
                      style="margin-bottom: 0.5rem; padding: 0.75rem;"
                    >
                      <div class="meta-row">
                        <dt>Name</dt>
                        <dd>{af.name}</dd>
                      </div>
                      <div class="meta-row">
                        <dt>Kind</dt>
                        <dd>{af.kind}</dd>
                      </div>
                      <button
                        onClick={() => handleSubscribe(sourceId, af)}
                        disabled={isSubscribed(
                          props.feeds,
                          sourceId,
                          af.externalId,
                        )}
                        style="margin-top: 0.5rem;"
                      >
                        {isSubscribed(props.feeds, sourceId, af.externalId)
                          ? "Subscribed"
                          : "Subscribe"}
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
