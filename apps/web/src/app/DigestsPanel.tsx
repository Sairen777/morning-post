import { createSignal, For, Show } from "solid-js";
import type { PublicDigest, DigestView } from "../api/types";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";

interface DigestsPanelProps {
  digests: PublicDigest[];
  onSelectDigest: (id: string) => Promise<DigestView>;
  onAuthError: () => void;
}

export default function DigestsPanel(props: DigestsPanelProps) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [digestView, setDigestView] = createSignal<DigestView | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleSelect = async (id: string) => {
    setSelectedId(id);
    setDigestView(null);
    setError(null);
    setLoading(true);

    try {
      const view = await props.onSelectDigest(id);
      setDigestView(view);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
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
        <h2>Digests</h2>
      </div>
      <Show
        when={props.digests.length > 0}
        fallback={<p class="hint">No digests yet. Run your first digest above.</p>}
      >
        <ul class="bullet-list">
          <For each={props.digests}>
            {(digest) => (
              <li>
                <button
                  onClick={() => handleSelect(digest.id)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "0.5rem 0",
                    cursor: "pointer",
                    color:
                      selectedId() === digest.id
                        ? "var(--accent)"
                        : "inherit",
                    "text-align": "left",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      "align-items": "center",
                      "flex-wrap": "wrap",
                    }}
                  >
                    <FormatTime ms={digest.periodStartMs} />
                    <span>–</span>
                    <FormatTime ms={digest.periodEndMs} />
                    <StatusBadge status={digest.status} />
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      {/* Selected digest detail */}
      <Show when={loading()}>
        <p style="padding: 1rem;">Loading digest…</p>
      </Show>
      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>
      <Show when={digestView()}>
        {(view) => (
          <div style="margin-top: 1.5rem;">
            <div class="section-title">
              <h3>
                Digest detail
              </h3>
              <a
                href={`/digests/${view().digest.id}.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View markdown
              </a>
            </div>
            <For each={view().groups}>
              {(group) => (
                <div class="card" style="margin-bottom: 1rem;">
                  <div class="meta-row">
                    <dt>Source</dt>
                    <dd>{group.sourceId}</dd>
                  </div>
                  <div class="meta-row">
                    <dt>Connector</dt>
                    <dd>{group.connectorId}</dd>
                  </div>
                  <For each={group.sections}>
                    {(section) => (
                      <div style="margin-top: 0.75rem;">
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            "align-items": "center",
                          }}
                        >
                          <strong>{section.feedName}</strong>
                          <Show when={section.feedRemoved}>
                            <span class="feed-removed">(removed)</span>
                          </Show>
                        </div>
                        <ul class="bullet-list">
                          <For each={section.points}>
                            {(point) => (
                              <li>
                                {point.text}
                                <Show when={point.sourceUrl}>
                                  {" "}
                                  <a
                                    href={point.sourceUrl!}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    source
                                  </a>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
