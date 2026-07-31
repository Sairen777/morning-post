import { createSignal, For, Show } from "solid-js";
import type { PublicDigestRun, DigestRunDetail } from "../api/types";
import { ApiClientError } from "../api/client";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";
import { formatDuration } from "./duration";
import ServiceIcon from "./ServiceIcon";

interface DigestRunsPanelProps {
  runs: PublicDigestRun[];
  onSelectRun: (id: string) => Promise<DigestRunDetail>;
  onRefresh: () => Promise<void>;
  onAuthError: () => void;
  nextCursor?: string;
  loadingMore?: boolean;
  onLoadMore?: () => Promise<void>;
}

const connectorLabels: Record<string, string> = {
  Telegram: "Telegram",
  Substack: "Substack",
  X: "X",
  YouTube: "YouTube",
  Reddit: "Reddit",
  RSS: "RSS feed",
};

export default function DigestRunsPanel(props: DigestRunsPanelProps) {
  const [detail, setDetail] = createSignal<DigestRunDetail | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);

  const handleRefresh = async () => {
    setError(null);
    try {
      await props.onRefresh();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("We couldn't refresh activity. Try again.");
      }
    }
  };

  const handleSelectRun = async (id: string) => {
    setError(null);
    setDetail(null);
    setLoading(true);
    setSelectedRunId(id);
    try {
      const result = await props.onSelectRun(id);
      setDetail(result);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("We couldn't load run diagnostics.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section class="activity-runs" aria-labelledby="activity-runs-heading">
      <div class="activity-runs-header">
        <div>
          <p class="app-content-kicker">Recent work</p>
          <h3 id="activity-runs-heading">Digest runs</h3>
          <p class="hint">A quick record of briefings prepared for your desk.</p>
        </div>
        <button type="button" onClick={handleRefresh} class="activity-refresh">Refresh activity</button>
      </div>

      <Show when={error()}>
        <div class="error" role="alert">{error()}</div>
      </Show>

      <Show
        when={props.runs.length > 0}
        fallback={<p class="profile-empty">No digest runs yet. Run a digest from the Digests view to begin.</p>}
      >
        <div class="run-summary-list">
          <For each={props.runs}>
            {(run) => (
              <article class="run-summary" aria-labelledby={`run-heading-${run.id}`}>
                <div class="run-summary-main">
                  <div class="run-summary-title">
                    <h4 id={`run-heading-${run.id}`}>
                      {run.digestId ? "Digest prepared" : run.status === "running" ? "Digest in progress" : "Digest run"}
                    </h4>
                    <StatusBadge status={run.status} label={run.status === "complete" ? "Ready" : run.status} />
                  </div>
                  <p class="run-summary-period">
                    <FormatTime ms={run.periodStartMs} />{" – "}<FormatTime ms={run.periodEndMs} />
                  </p>
                  <dl class="run-summary-meta">
                    <div>
                      <dt>Requested</dt>
                      <dd><FormatTime ms={run.startedAt} /></dd>
                    </div>
                    <div>
                      <dt>Trigger</dt>
                      <dd>{run.trigger === "manual" ? "You" : "Schedule"}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>{run.finishedAt === null ? "Still running" : formatDuration(run.finishedAt - run.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Feed steps</dt>
                      <dd>
                        {selectedRunId() === run.id && detail() !== null
                          ? detail()!.feeds.length
                          : "Load details"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div class="run-summary-actions">
                  <Show when={run.digestId}>
                    <a class="primary-link" href={`/issues/${run.digestId}`}>Read digest</a>
                  </Show>
                  <details class="run-diagnostics">
                    <summary>Technical details</summary>
                    <div class="run-diagnostics-content">
                      <dl class="meta-row-list">
                        <div><dt>Period</dt><dd><FormatTime ms={run.periodStartMs} />{" – "}<FormatTime ms={run.periodEndMs} /></dd></div>
                        <div><dt>Status</dt><dd><StatusBadge status={run.status} /></dd></div>
                        <div><dt>Started</dt><dd><FormatTime ms={run.startedAt} /></dd></div>
                        <Show when={run.finishedAt !== null}>
                          <div><dt>Finished</dt><dd><FormatTime ms={run.finishedAt!} /></dd></div>
                        </Show>
                      </dl>
                      <Show when={run.errorMessage}>
                        <p class="error run-error">{run.errorMessage}</p>
                      </Show>
                      <button
                        type="button"
                        class="run-details-button"
                        onClick={() => handleSelectRun(run.id)}
                        disabled={loading()}
                      >
                        {loading() && selectedRunId() === run.id ? "Loading details…" : "Load feed diagnostics"}
                      </button>
                      <Show when={selectedRunId() === run.id && detail() !== null}>
                        <div class="run-feed-list" aria-live="polite">
                          <p class="run-feed-count">{detail()!.feeds.length} feed steps recorded</p>
                          <For each={detail()!.feeds}>
                            {(feed) => (
                              <article class="run-feed-detail">
                                <div class="run-feed-heading">
                                  <div class="run-feed-service">
                                    <ServiceIcon connectorId={feed.connectorId} title={connectorLabels[feed.connectorId] ?? "Connected service"} />
                                    <strong>{connectorLabels[feed.connectorId] ?? "Connected service"}</strong>
                                  </div>
                                  <StatusBadge status={feed.status} />
                                </div>
                                <dl class="meta-row-list">
                                  <div><dt>Stage</dt><dd>{feed.stage}</dd></div>
                                  <div><dt>Feed</dt><dd>{feed.feedName ?? "Source-level event"}</dd></div>
                                  <Show when={feed.itemCount !== null}>
                                    <div><dt>Items</dt><dd>{feed.itemCount}</dd></div>
                                  </Show>
                                  <div><dt>Started</dt><dd><FormatTime ms={feed.startedAt} /></dd></div>
                                  <Show when={feed.finishedAt !== null}>
                                    <div><dt>Finished</dt><dd><FormatTime ms={feed.finishedAt!} /></dd></div>
                                  </Show>
                                </dl>
                                <Show when={feed.errorMessage}>
                                  <p class="error run-error">{feed.errorMessage}</p>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </details>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.nextCursor}>
        <div class="activity-load-more">
          <button type="button" onClick={() => props.onLoadMore?.()} disabled={props.loadingMore}>
            {props.loadingMore ? "Loading more activity…" : "Load more activity"}
          </button>
        </div>
      </Show>
    </section>
  );
}
