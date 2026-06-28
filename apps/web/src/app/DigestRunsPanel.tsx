import { createSignal, For, Show } from "solid-js";
import type { PublicDigestRun, DigestRunDetail } from "../api/types";
import { ApiClientError, getDigestRunDetail } from "../api/client";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";

interface DigestRunsPanelProps {
  runs: PublicDigestRun[];
  onSelectRun: (id: string) => Promise<DigestRunDetail>;
  onRefresh: () => Promise<void>;
  onAuthError: () => void;
}

export default function DigestRunsPanel(props: DigestRunsPanelProps) {
  const [detail, setDetail] = createSignal<DigestRunDetail | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedRunId, setSelectedRunId] = createSignal<string | null>(null);

  const handleRefresh = async () => {
    try {
      await props.onRefresh();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
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
        setError("An unexpected error occurred");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Digest runs</h2>
        <button onClick={handleRefresh}>Refresh</button>
      </div>

      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>

      <Show
        when={props.runs.length > 0}
        fallback={<p>No digest runs yet. Run a digest first.</p>}
      >
        <For each={props.runs}>
          {(run) => (
            <div class="card">
              <div class="meta-row">
                <dt>Period</dt>
                <dd>
                  <FormatTime ms={run.periodStartMs} />
                  {" – "}
                  <FormatTime ms={run.periodEndMs} />
                </dd>
              </div>

              <div class="meta-row">
                <dt>Trigger</dt>
                <dd>{run.trigger}</dd>
              </div>

              <div class="meta-row">
                <dt>Status</dt>
                <dd>
                  <StatusBadge
                    status={run.status as "pending" | "complete" | "failed"}
                  />
                </dd>
              </div>

              <div class="meta-row">
                <dt>Started</dt>
                <dd>
                  <FormatTime ms={run.startedAt} />
                </dd>
              </div>

              <Show when={run.finishedAt !== null}>
                <div class="meta-row">
                  <dt>Finished</dt>
                  <dd>
                    <FormatTime ms={run.finishedAt!} />
                  </dd>
                </div>

                <div class="meta-row">
                  <dt>Duration</dt>
                  <dd>
                    {(() => {
                      const diffMs = run.finishedAt! - run.startedAt;
                      const seconds = Math.floor(diffMs / 1000);
                      const minutes = Math.floor(seconds / 60);
                      const hours = Math.floor(minutes / 60);
                      if (hours > 0) {
                        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
                      }
                      if (minutes > 0) {
                        return `${minutes}m ${seconds % 60}s`;
                      }
                      return `${seconds}s`;
                    })()}
                  </dd>
                </div>
              </Show>

              <Show when={run.errorMessage}>
                <div class="error">{run.errorMessage}</div>
              </Show>

              <button
                onClick={() => handleSelectRun(run.id)}
                disabled={loading()}
              >
                {loading() && selectedRunId() === run.id
                  ? "Loading details…"
                  : "View run details"}
              </button>

              <Show when={selectedRunId() === run.id && detail() !== null}>
                <div class="section-title">Run detail</div>

                <Show when={detail()!.run.digestId}>
                  <p>Digest id: {detail()!.run.digestId}</p>
                </Show>

                <For each={detail()!.feeds}>
                  {(feed) => (
                    <div class="card">
                      <div class="meta-row">
                        <dt>Stage</dt>
                        <dd>{feed.stage}</dd>
                      </div>

                      <div class="meta-row">
                        <dt>Status</dt>
                        <dd>
                          <StatusBadge
                            status={feed.status as "pending" | "complete" | "failed"}
                          />
                        </dd>
                      </div>

                      <div class="meta-row">
                        <dt>Connector</dt>
                        <dd>{feed.connectorId}</dd>
                      </div>

                      <div class="meta-row">
                        <dt>Feed</dt>
                        <dd>
                          {feed.feedName ?? feed.feedExternalId ??
                            "Source-level event"}
                        </dd>
                      </div>

                      <Show when={feed.itemCount !== null}>
                        <div class="meta-row">
                          <dt>Items</dt>
                          <dd>{feed.itemCount}</dd>
                        </div>
                      </Show>

                      <div class="meta-row">
                        <dt>Started</dt>
                        <dd>
                          <FormatTime ms={feed.startedAt} />
                        </dd>
                      </div>

                      <Show when={feed.finishedAt !== null}>
                        <div class="meta-row">
                          <dt>Finished</dt>
                          <dd>
                            <FormatTime ms={feed.finishedAt!} />
                          </dd>
                        </div>
                      </Show>

                      <Show when={feed.errorMessage}>
                        <div class="error">{feed.errorMessage}</div>
                      </Show>
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
