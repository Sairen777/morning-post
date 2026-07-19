import { createSignal, For, Show } from "solid-js";
import type { DigestSection, DigestView, PublicDigest } from "../api/types";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";

function safeHttpUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function DigestSectionView(props: { section: DigestSection }) {
  const articleContent = () => {
    const content = props.section.content;
    return content.kind === "articles" ? content : undefined;
  };
  const aggregateContent = () => {
    const content = props.section.content;
    return content.kind === "aggregate" ? content : undefined;
  };

  return (
    <section class="digest-section">
      <h4 class="digest-feed-heading">
        {props.section.feedName}
        <Show when={props.section.feedRemoved}>
          <span class="feed-removed">(removed)</span>
        </Show>
      </h4>
      <Show
        when={articleContent()}
        fallback={
          <Show
            when={aggregateContent()}
            fallback={<p class="hint digest-empty">No content available.</p>}
          >
            {(aggregate) => (
              <ul class="bullet-list">
                <For each={aggregate().points}>
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
            )}
          </Show>
        }
      >
        {(articles) => (
          <Show
            when={articles().articles.length > 0}
            fallback={<p class="hint digest-empty">No articles available.</p>}
          >
            <div class="article-list">
              <For each={articles().articles}>
                {(article) => (
                  <article class="digest-article">
                    <h5 class="digest-article-heading">
                      <Show when={article.sourceUrl} fallback={article.title}>
                        <a
                          href={article.sourceUrl!}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {article.title}
                        </a>
                      </Show>
                    </h5>
                    <div class="digest-article-meta">
                      <Show when={article.contentAccess === "preview"}>
                        <span
                          class="digest-preview"
                          aria-label="Preview article"
                        >
                          Preview
                        </span>
                      </Show>
                      <FormatTime ms={article.publishedAt} />
                    </div>
                    <Show
                      when={article.points.length > 0}
                      fallback={
                        <p class="hint digest-empty">
                          No points available for this article.
                        </p>
                      }
                    >
                      <ul class="bullet-list article-points">
                        <For each={article.points}>
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
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </section>
  );
}

interface DigestsPanelProps {
  digests: PublicDigest[];
  onSelectDigest: (id: string) => Promise<DigestView>;
  onDeleteDigest: (id: string) => Promise<void>;
  onAuthError: () => void;
  nextCursor?: string;
  loadingMore?: boolean;
  onLoadMore?: () => Promise<void>;
}

export default function DigestsPanel(props: DigestsPanelProps) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [digestView, setDigestView] = createSignal<DigestView | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
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

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this digest?")) return;

    const wasSelected = selectedId() === id;
    setDeletingId(id);
    setError(null);

    try {
      await props.onDeleteDigest(id);
      if (wasSelected) {
        setSelectedId(null);
        setDigestView(null);
      }
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401) {
          props.onAuthError();
        }
      }
      const message = err instanceof Error ? err.message : "Delete failed";
      setError(message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Digests</h2>
      </div>
      <Show
        when={props.digests.length > 0}
        fallback={
          <p class="hint">No digests yet. Run your first digest above.</p>
        }
      >
        <ul class="bullet-list">
          <For each={props.digests}>
            {(digest, index) => (
              <li>
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(digest.id)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: "0.5rem 0",
                      cursor: "pointer",
                      color: selectedId() === digest.id
                        ? "var(--accent)"
                        : "inherit",
                      flex: "1",
                      "text-align": "left",
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        "align-items": "center",
                        "flex-wrap": "wrap",
                      }}
                    >
                      <span class="digest-ordinal">#{index() + 1}</span>
                      <FormatTime ms={digest.periodStartMs} />
                      <span>–</span>
                      <FormatTime ms={digest.periodEndMs} />
                      <StatusBadge status={digest.status} />
                    </span>
                  </button>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => handleDelete(digest.id)}
                    disabled={deletingId() === digest.id}
                  >
                    {deletingId() === digest.id ? "Deleting…" : "Delete digest"}
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.nextCursor}>
        <div style="text-align: center; margin-top: 1rem;">
          <button
            type="button"
            onClick={() => props.onLoadMore?.()}
            disabled={props.loadingMore}
          >
            {props.loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
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
                <section class="digest-group">
                  <div class="meta-row">
                    <dt>Source</dt>
                    <dd>{group.sourceId}</dd>
                  </div>
                  <div class="meta-row">
                    <dt>Connector</dt>
                    <dd>{group.connectorId}</dd>
                  </div>
                  <For each={group.sections}>
                    {(section) => <DigestSectionView section={section} />}
                  </For>
                </section>
              )}
            </For>
            <Show when={view().paidPosts.length > 0}>
              <section class="paid-posts" aria-labelledby="paid-posts-title">
                <h3 id="paid-posts-title">Paid posts</h3>
                <p class="hint">
                  Inaccessible paid posts are never summarized. When enabled,
                  linked titles appear at the end of each digest so the reader
                  can decide whether to subscribe.
                </p>
                <ul class="paid-post-list">
                  <For each={view().paidPosts}>
                    {(post) => (
                      <li>
                        <Show
                          when={safeHttpUrl(post.sourceUrl)}
                          fallback={post.title}
                        >
                          {(sourceUrl) => (
                            <a
                              href={sourceUrl()}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {post.title}
                            </a>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
