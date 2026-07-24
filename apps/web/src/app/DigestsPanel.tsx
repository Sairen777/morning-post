import { createSignal, For, Show } from "solid-js";
import type {
  DigestSection,
  DigestStory,
  DigestView,
  PublicDigest,
  StoryFeedbackInput,
  StoryFeedbackStoryAction,
  StoryFeedbackTarget,
  StoryFeedbackTargetAction,
} from "../api/types";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";
function safeHttpUrl(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
type PaidPost = DigestView["paidPosts"][number];

interface PaidPostGroup {
  newsletterName: string;
  posts: PaidPost[];
}

function groupPaidPosts(posts: PaidPost[]): PaidPostGroup[] {
  const groups = new Map<string, PaidPost[]>();
  for (const post of posts) {
    const existing = groups.get(post.newsletterName);
    if (existing) {
      existing.push(post);
    } else {
      groups.set(post.newsletterName, [post]);
    }
  }
  return Array.from(groups, ([newsletterName, groupedPosts]) => ({
    newsletterName,
    posts: groupedPosts,
  }));
}

function hasVisibleDigestSection(section: DigestSection): boolean {
  return (
    section.content.kind !== "articles" || section.content.articles.length > 0
  );
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
                          {(point) => <li>{point.text}</li>}
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

const storyActions: ReadonlyArray<{
  action: StoryFeedbackStoryAction;
  label: string;
}> = [
  { action: "relevant", label: "Relevant" },
  { action: "not_relevant", label: "Not for me" },
  { action: "already_known", label: "Already knew" },
  { action: "too_repetitive", label: "Too repetitive" },
];

const targetActions: ReadonlyArray<{
  action: StoryFeedbackTargetAction;
  label: string;
}> = [
  { action: "follow_topic", label: "Follow" },
  { action: "show_less_topic", label: "Show less" },
  { action: "mute_topic", label: "Mute" },
];

interface StoryFeedbackState {
  kind: "pending" | "success" | "error";
  message: string;
}

function storyFeedbackKey(
  storyId: string,
  input: StoryFeedbackInput,
): string {
  return JSON.stringify([
    storyId,
    input.action,
    input.target?.kind ?? "",
    input.target?.label ?? "",
  ]);
}

interface StoryCardProps {
  story: DigestStory;
  feedbackAvailable: boolean;
  feedbackState: (input: StoryFeedbackInput) => StoryFeedbackState | undefined;
  isPending: (input: StoryFeedbackInput) => boolean;
  onSubmit: (input: StoryFeedbackInput) => void;
}

function StoryCard(props: StoryCardProps) {
  const targets: StoryFeedbackTarget[] = [
    ...props.story.topics.map((label) => ({ kind: "topic" as const, label })),
    ...props.story.entities.map((label) => ({ kind: "entity" as const, label })),
  ];
  const headingId = `story-${props.story.id}-title`;
  const feedbackInputs: StoryFeedbackInput[] = [
    ...storyActions.map(({ action }) => ({
      digestStoryId: props.story.id,
      action,
    })),
    ...targets.flatMap((target) =>
      targetActions.map(({ action }) => ({
        digestStoryId: props.story.id,
        action,
        target,
      }))
    ),
  ];
  const feedbackMessages = () =>
    feedbackInputs.flatMap((input) => {
      const state = props.feedbackState(input);
      return state ? [state] : [];
    });

  return (
    <article class="story-card" aria-labelledby={headingId}>
      <h4 class="story-heading" id={headingId}>{props.story.title}</h4>
      <div class="story-meta" aria-label="Story relevance">
        <span>{props.story.relevanceScore}% relevance</span>
        <span aria-hidden="true">·</span>
        <span>
          {props.story.sources.length}{" "}
          {props.story.sources.length === 1 ? "source" : "sources"}
        </span>
        <Show when={props.story.matchedInterestRuleIds.length > 0}>
          <span aria-hidden="true">·</span>
          <span>
            {props.story.matchedInterestRuleIds.length} matched{" "}
            {props.story.matchedInterestRuleIds.length === 1 ? "interest" : "interests"}
          </span>
        </Show>
      </div>

      <Show
        when={props.story.points.length > 0}
        fallback={<p class="hint digest-empty">No summary points available.</p>}
      >
        <ul class="bullet-list story-points">
          <For each={props.story.points}>
            {(point) => (
              <li>
                {point.text}
                <Show when={safeHttpUrl(point.sourceUrl)}>
                  {(sourceUrl) => (
                    <>
                      {" "}
                      <a
                        href={sourceUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        source
                      </a>
                    </>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.story.topics.length > 0 || props.story.entities.length > 0}>
        <dl class="story-labels">
          <Show when={props.story.topics.length > 0}>
            <div class="story-label-group">
              <dt>Topics</dt>
              <dd>
                <For each={props.story.topics}>
                  {(topic) => <span class="badge">{topic}</span>}
                </For>
              </dd>
            </div>
          </Show>
          <Show when={props.story.entities.length > 0}>
            <div class="story-label-group">
              <dt>Entities</dt>
              <dd>
                <For each={props.story.entities}>
                  {(entity) => <span class="badge">{entity}</span>}
                </For>
              </dd>
            </div>
          </Show>
        </dl>
      </Show>

      <section class="story-sources" aria-labelledby={`story-${props.story.id}-sources`}>
        <h5 id={`story-${props.story.id}-sources`}>Sources</h5>
        <Show
          when={props.story.sources.length > 0}
          fallback={<p class="hint digest-empty">No source details available.</p>}
        >
          <ul class="story-source-list">
            <For each={props.story.sources}>
              {(source) => (
                <li class="story-source">
                  <Show
                    when={safeHttpUrl(source.url)}
                    fallback={<span>{source.title ?? "Untitled source"}</span>}
                  >
                    {(sourceUrl) => (
                      <a
                        href={sourceUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.title ?? source.feedName}
                      </a>
                    )}
                  </Show>
                  <Show when={source.title !== null}>
                    <span class="story-source-feed">{source.feedName}</span>
                  </Show>
                  <span class="badge">{source.connectorId}</span>
                  <FormatTime ms={source.publishedAt} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section
        class="story-feedback"
        aria-labelledby={`story-${props.story.id}-feedback`}
      >
        <h5 id={`story-${props.story.id}-feedback`}>Tune this story</h5>
        <div class="story-feedback-actions" role="group" aria-label="Story feedback">
          <For each={storyActions}>
            {(action) => {
              const input: StoryFeedbackInput = {
                digestStoryId: props.story.id,
                action: action.action,
              };
              const pending = () => props.isPending(input);
              return (
                <button
                  type="button"
                  aria-label={`${action.label}: ${props.story.title}`}
                  aria-busy={pending()}
                  disabled={!props.feedbackAvailable || pending()}
                  onClick={() => props.onSubmit(input)}
                >
                  {pending() ? "Saving…" : action.label}
                </button>
              );
            }}
          </For>
        </div>

        <Show when={targets.length > 0}>
          <ul class="story-target-list" aria-label="Topic and entity feedback">
            <For each={targets}>
              {(target) => (
                <li class="story-target-row">
                  <span class="story-target-label">
                    <span class="badge">{target.kind}</span>{" "}
                    {target.label}
                  </span>
                  <div
                    class="story-target-actions"
                    role="group"
                    aria-label={`Feedback for ${target.kind} ${target.label}`}
                  >
                    <For each={targetActions}>
                      {(action) => {
                        const input: StoryFeedbackInput = {
                          digestStoryId: props.story.id,
                          action: action.action,
                          target,
                        };
                        const pending = () => props.isPending(input);
                        return (
                          <button
                            type="button"
                            aria-label={`${action.label} ${target.kind} ${target.label}`}
                            aria-busy={pending()}
                            disabled={!props.feedbackAvailable || pending()}
                            onClick={() => props.onSubmit(input)}
                          >
                            {pending() ? "Saving…" : action.label}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <For each={feedbackMessages()}>
          {(state) => (
            <p
              class={`story-feedback-state ${state.kind}`}
              role={state.kind === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {state.message}
            </p>
          )}
        </For>
      </section>
    </article>
  );
}

interface DigestsPanelProps {
  digests: PublicDigest[];
  onSelectDigest: (id: string) => Promise<DigestView>;
  onDeleteDigest: (id: string) => Promise<void>;
  onAuthError: () => void;
  nextCursor?: string;
  onSubmitFeedback?: (
    storyId: string,
    input: StoryFeedbackInput,
  ) => Promise<unknown>;
  onFeedbackSuccess?: () => void | Promise<void>;
  loadingMore?: boolean;
  onLoadMore?: () => Promise<void>;
}

export default function DigestsPanel(props: DigestsPanelProps) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [digestView, setDigestView] = createSignal<DigestView | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [pendingFeedback, setPendingFeedback] = createSignal<
    Record<string, true>
  >({});
  const [feedbackStates, setFeedbackStates] = createSignal<
    Record<string, StoryFeedbackState>
  >({});

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

  const handleStoryFeedback = async (
    story: DigestStory,
    input: StoryFeedbackInput,
  ) => {
    const submitFeedback = props.onSubmitFeedback;
    if (!submitFeedback) return;
    const feedbackKey = storyFeedbackKey(story.id, input);
    if (pendingFeedback()[feedbackKey]) return;

    setPendingFeedback((current) => ({ ...current, [feedbackKey]: true }));
    setFeedbackStates((current) => ({
      ...current,
      [feedbackKey]: { kind: "pending", message: "Saving feedback…" },
    }));

    try {
      await submitFeedback(story.storyId, input);
      setFeedbackStates((current) => ({
        ...current,
        [feedbackKey]: { kind: "success", message: "Feedback saved." },
      }));
      try {
        await props.onFeedbackSuccess?.();
      } catch {
        // The feedback is durable even when a follow-up profile refresh fails.
      }
    } catch (err: unknown) {
      const status = err instanceof Error && "status" in err &&
          typeof err.status === "number"
        ? err.status
        : undefined;
      if (status === 401) {
        props.onAuthError();
      }
      setFeedbackStates((current) => ({
        ...current,
        [feedbackKey]: {
          kind: "error",
          message: status === 401
            ? "Your session expired before feedback could be saved."
            : err instanceof Error
            ? err.message
            : "Feedback could not be saved.",
        },
      }));
    } finally {
      setPendingFeedback((current) => {
        const next = { ...current };
        delete next[feedbackKey];
        return next;
      });
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
              <h3>Digest detail</h3>
              <a
                href={`/digests/${view().digest.id}.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View markdown
              </a>
            </div>
            <Show
              when={view().digest.status === "failed" &&
                view().failureReason !== null}
            >
              <div class="error" role="alert">
                <strong>Failure reason:</strong>{" "}
                {view().failureReason}
              </div>
            </Show>
            <Show
              when={view().digest.contentMode === "stories" ||
                (view().stories?.length ?? 0) > 0}
              fallback={
                <For
                  each={view().groups.filter((group) =>
                    group.sections.some(hasVisibleDigestSection)
                  )}
                >
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
                      <For each={group.sections.filter(hasVisibleDigestSection)}>
                        {(section) => <DigestSectionView section={section} />}
                      </For>
                    </section>
                  )}
                </For>
              }
            >
              <Show
                when={(view().stories?.length ?? 0) > 0}
                fallback={
                  <p class="hint digest-empty" role="status">
                    No stories met this digest's delivery criteria.
                  </p>
                }
              >
                <div class="story-list">
                  <For each={view().stories ?? []}>
                    {(story) => (
                      <StoryCard
                        story={story}
                        feedbackAvailable={props.onSubmitFeedback !== undefined}
                        feedbackState={(input) =>
                          feedbackStates()[storyFeedbackKey(story.id, input)]}
                        isPending={(input) =>
                          pendingFeedback()[storyFeedbackKey(story.id, input)] === true}
                        onSubmit={(input) => void handleStoryFeedback(story, input)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={view().paidPosts.length > 0}>
              <section class="paid-posts" aria-labelledby="paid-posts-title">
                <h3 id="paid-posts-title">Paid posts</h3>
                <p class="hint">
                  Inaccessible paid posts are never summarized. When enabled,
                  linked titles appear at the end of each digest so the reader
                  can decide whether to subscribe.
                </p>
                <For each={groupPaidPosts(view().paidPosts)}>
                  {(group, index) => (
                    <div class="paid-post-group">
                      <h4
                        class="paid-post-newsletter"
                        id={`paid-post-newsletter-${index()}`}
                      >
                        {group.newsletterName}
                      </h4>
                      <ul
                        class="paid-post-list"
                        aria-labelledby={`paid-post-newsletter-${index()}`}
                      >
                        <For each={group.posts}>
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
                    </div>
                  )}
                </For>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
