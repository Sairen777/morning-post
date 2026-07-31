import { createSignal, For, Show } from "solid-js";
import type {
  DigestSection,
  DigestSort,
  DigestStory,
  DigestView,
  PublicDigest,
  StoryFeedbackInput,
  StoryFeedbackStoryAction,
  StoryFeedbackTarget,
  StoryFeedbackTargetAction,
} from "../api/types";
import { digestSorts } from "../api/types";
import { digestItemMediaUrl } from "../api/client";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";
import ServiceIcon from "./ServiceIcon";
import { formatDuration } from "./duration";

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

function connectorLabel(connectorId: string): string {
  const normalized = connectorId.trim().toLowerCase();
  if (normalized === "x" || normalized === "twitter") return "X";
  if (normalized === "rss") return "RSS";
  if (normalized === "youtube") return "YouTube";
  if (normalized === "substack") return "Substack";
  if (normalized === "telegram") return "Telegram";
  if (normalized === "reddit") return "Reddit";
  return connectorId.trim() || "Source";
}

function ServiceIdentity(props: { connectorId: string }) {
  const label = () => connectorLabel(props.connectorId);
  return (
    <span class="service-identity">
      <ServiceIcon connectorId={props.connectorId} title={label()} />
      <span>{label()}</span>
    </span>
  );
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

type DigestStorySource = DigestStory["sources"][number];

interface StoryFeedEntry {
  story: DigestStory;
  sources: DigestStorySource[];
}

interface StoryFeedGroup {
  feedName: string;
  stories: StoryFeedEntry[];
}

interface StoryConnectorGroup {
  connectorId: string;
  feeds: StoryFeedGroup[];
}

function groupStoriesBySource(stories: DigestStory[]): StoryConnectorGroup[] {
  const connectors = new Map<string, {
    group: StoryConnectorGroup;
    feeds: Map<string, StoryFeedGroup>;
  }>();

  const getFeed = (
    connectorId: string,
    feedKey: string,
    feedName: string,
  ): StoryFeedGroup => {
    let connector = connectors.get(connectorId);
    if (!connector) {
      connector = {
        group: { connectorId, feeds: [] },
        feeds: new Map(),
      };
      connectors.set(connectorId, connector);
    }
    let feed = connector.feeds.get(feedKey);
    if (!feed) {
      feed = { feedName, stories: [] };
      connector.feeds.set(feedKey, feed);
      connector.group.feeds.push(feed);
    }
    return feed;
  };

  for (const story of stories) {
    if (story.sources.length === 0) {
      getFeed("Other", "unassigned", "Unassigned stories").stories.push({
        story,
        sources: [],
      });
      continue;
    }
    const entries = new Map<string, StoryFeedEntry>();
    for (const source of story.sources) {
      const feedKey = source.feedId ?? `${source.connectorId}:${source.feedName}`;
      const instanceKey = `${source.connectorId}:${feedKey}`;
      let entry = entries.get(instanceKey);
      if (!entry) {
        entry = { story, sources: [] };
        entries.set(instanceKey, entry);
        getFeed(source.connectorId, feedKey, source.feedName).stories.push(entry);
      }
      entry.sources.push(source);
    }
  }

  return Array.from(connectors.values(), ({ group }) => group);
}

interface StoryCardProps {
  story: DigestStory;
  displayedSources: DigestStorySource[];
  instanceKey: string;
  mediaDigestId?: string;
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
  const instanceId = `story-${props.story.id}-${props.instanceKey}`;
  const headingId = `${instanceId}-title`;
  const [mediaIndex, setMediaIndex] = createSignal(0);
  const mediaSources = () =>
    props.mediaDigestId ? props.story.sources.filter((source) => source.itemId) : [];
  const mediaSource = () => mediaSources()[mediaIndex()];
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
      <Show when={mediaSource()}>
        {(source) => (
          <img
            class="story-media"
            src={digestItemMediaUrl(props.mediaDigestId!, source().itemId)}
            alt=""
            loading="lazy"
            onError={() => setMediaIndex((index) => index + 1)}
          />
        )}
      </Show>
      <h3 class="story-heading" id={headingId}>{props.story.title}</h3>

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
      <Show when={props.displayedSources.length > 0}>
        <div class="story-sources" aria-label="Story byline">
          <span class="story-byline-label">From</span>
          <div class="story-source-list">
            <For each={props.displayedSources}>
              {(source) => (
                <Show
                  when={safeHttpUrl(source.url)}
                  fallback={
                    <span class="story-source">
                      {source.title ?? source.feedName}
                    </span>
                  }
                >
                  {(sourceUrl) => (
                    <a
                      class="story-source"
                      href={sourceUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.title ?? source.feedName}
                    </a>
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>
      </Show>


      <details class="story-details">
        <summary>Story details and tuning</summary>
        <div class="story-detail-content">
          <section
            class="story-detail-section"
            aria-labelledby={`${instanceId}-context`}
          >
            <h5 id={`${instanceId}-context`}>Story context</h5>
            <div class="story-meta" aria-label="Story relevance">
              <span>{props.story.relevanceScore}% relevance</span>
              <span aria-hidden="true">·</span>
              <span>
                {props.displayedSources.length}{" "}
                {props.displayedSources.length === 1 ? "source" : "sources"}
              </span>
              <Show when={props.story.matchedInterestRuleIds.length > 0}>
                <span aria-hidden="true">·</span>
                <span>
                  {props.story.matchedInterestRuleIds.length} matched{" "}
                  {props.story.matchedInterestRuleIds.length === 1 ? "interest" : "interests"}
                </span>
              </Show>
            </div>

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
          </section>

          <section
            class="story-detail-section story-source-details"
            aria-labelledby={`${instanceId}-source-details`}
          >
            <h5 id={`${instanceId}-source-details`}>Source details</h5>
            <Show
              when={props.displayedSources.length > 0}
              fallback={<p class="hint digest-empty">No source details available.</p>}
            >
              <ul class="story-source-detail-list">
                <For each={props.displayedSources}>
                  {(source) => (
                    <li class="story-source-detail">
                      <dl>
                        <div>
                          <dt>Publication</dt>
                          <dd>{source.title ?? "Untitled source"}</dd>
                        </div>
                        <div>
                          <dt>Feed</dt>
                          <dd>{source.feedName}</dd>
                        </div>
                        <div>
                          <dt>Connector</dt>
                          <dd><ServiceIdentity connectorId={source.connectorId} /></dd>
                        </div>
                        <div>
                          <dt>Published</dt>
                          <dd><FormatTime ms={source.publishedAt} /></dd>
                        </div>
                      </dl>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section
            class="story-feedback"
            aria-labelledby={`${instanceId}-feedback`}
          >
            <h5 id={`${instanceId}-feedback`}>Tune this story</h5>
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
        </div>
      </details>
    </article>
  );
}

interface DigestFeedbackProps {
  onSubmitFeedback?: (
    storyId: string,
    input: StoryFeedbackInput,
  ) => Promise<unknown>;
  onFeedbackSuccess?: () => void | Promise<void>;
  onAuthError: () => void;
}

export interface DigestViewContentProps extends DigestFeedbackProps {
  view: DigestView;
  reader?: boolean;
}

export function DigestViewContent(props: DigestViewContentProps) {
  const [pendingFeedback, setPendingFeedback] = createSignal<
    Record<string, true>
  >({});
  const [feedbackStates, setFeedbackStates] = createSignal<
    Record<string, StoryFeedbackState>
  >({});

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

  const view = () => props.view;
  const storyMode = () =>
    view().digest.contentMode === "stories" || (view().stories?.length ?? 0) > 0;

  return (
    <div class={`digest-view-content${props.reader ? " digest-reader-content" : ""}`}>
      <Show
        when={view().digest.status === "failed" && view().failureReason !== null}
      >
        <div class="error" role="alert">
          <strong>Failure reason:</strong>{" "}
          {view().failureReason}
        </div>
      </Show>
      <Show
        when={storyMode()}
        fallback={
          <Show
            when={view().groups.some((group) =>
              group.sections.some(hasVisibleDigestSection)
            )}
            fallback={
              <p class="hint digest-empty" role="status">
                No coverage was available for this period.
              </p>
            }
          >
            <div class="legacy-digest-groups">
              <For
                each={view().groups.filter((group) =>
                  group.sections.some(hasVisibleDigestSection)
                )}
              >
                {(group) => (
                  <section class="digest-group">
                    <div class="digest-group-heading">
                      <ServiceIdentity connectorId={group.connectorId} />
                    </div>
                    <For each={group.sections.filter(hasVisibleDigestSection)}>
                      {(section) => <DigestSectionView section={section} />}
                    </For>
                  </section>
                )}
              </For>
            </div>
          </Show>
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
          <div class="story-source-groups">
            <For each={groupStoriesBySource(view().stories ?? [])}>
              {(connector, connectorIndex) => (
                <section class="story-connector-group">
                  <h2 class="story-connector-heading">
                    <ServiceIdentity connectorId={connector.connectorId} />
                  </h2>
                  <For each={connector.feeds}>
                    {(feed, feedIndex) => (
                      <section class="story-feed-group">
                        <h3 class="story-feed-heading">{feed.feedName}</h3>
                        <div class="story-list">
                          <For each={feed.stories}>
                            {(entry, storyIndex) => (
                              <StoryCard
                                story={entry.story}
                                displayedSources={entry.sources}
                                instanceKey={`${connectorIndex()}-${feedIndex()}-${storyIndex()}`}
                                mediaDigestId={props.reader ? view().digest.id : undefined}
                                feedbackAvailable={props.onSubmitFeedback !== undefined}
                                feedbackState={(input) =>
                                  feedbackStates()[storyFeedbackKey(entry.story.id, input)]}
                                isPending={(input) =>
                                  pendingFeedback()[storyFeedbackKey(entry.story.id, input)] === true}
                                onSubmit={(input) =>
                                  void handleStoryFeedback(entry.story, input)}
                              />
                            )}
                          </For>
                        </div>
                      </section>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={view().paidPosts.length > 0}>
        <section class="paid-posts" aria-labelledby="paid-posts-title">
          <h2 id="paid-posts-title">Paid posts</h2>
          <p class="hint">
            Inaccessible paid posts are never summarized. Linked titles remain
            readable here so you can decide whether to subscribe.
          </p>
          <For each={groupPaidPosts(view().paidPosts)}>
            {(group, index) => (
              <div class="paid-post-group">
                <h3
                  class="paid-post-newsletter"
                  id={`paid-post-newsletter-${index()}`}
                >
                  {group.newsletterName}
                </h3>
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
  );
}

interface DigestsPanelProps {
  digests: PublicDigest[];
  /** Retained for callers that still own digest fetching; rows no longer expand inline. */
  onSelectDigest?: (id: string) => Promise<DigestView>;
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
  sort?: DigestSort;
  onSortChange?: (sort: DigestSort) => void;
}

const digestSortLabels: Record<DigestSort, string> = {
  requested_desc: "Newest requested",
  requested_asc: "Oldest requested",
  period_desc: "Latest coverage",
  period_asc: "Earliest coverage",
};

export default function DigestsPanel(props: DigestsPanelProps) {
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this digest? This cannot be undone.")) return;

    setDeletingId(id);
    setError(null);
    try {
      await props.onDeleteDigest(id);
    } catch (err: unknown) {
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401) props.onAuthError();
      }
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section class="card digest-index" aria-labelledby="digest-index-title">
      <div class="digest-index-header">
        <div>
          <p class="app-content-kicker">The archive</p>
          <h2 id="digest-index-title">Digests</h2>
          <p class="digest-index-deck">
            A running record of the briefings prepared for your reading desk.
            Open a completed issue to read its full coverage.
          </p>
        </div>
        <Show when={props.onSortChange}>
          <div class="digest-sort">
            <label for="digest-sort">Order by</label>
            <select
              id="digest-sort"
              value={props.sort ?? "requested_desc"}
              onChange={(event) =>
                props.onSortChange?.(
                  event.currentTarget.value as DigestSort,
                )}
            >
              <For each={digestSorts}>
                {(sort) => <option value={sort}>{digestSortLabels[sort]}</option>}
              </For>
            </select>
          </div>
        </Show>
      </div>

      <Show
        when={props.digests.length > 0}
        fallback={
          <p class="digest-index-empty" role="status">
            No digests yet. Run your first briefing above to begin the archive.
          </p>
        }
      >
        <div class="digest-index-list">
          <For each={props.digests}>
            {(digest, index) => (
              <article class="digest-index-row">
                <div class="digest-index-row-main">
                  <div class="digest-index-row-kicker">
                    <span class="digest-ordinal">Issue {index() + 1}</span>
                    <StatusBadge status={digest.status} />
                  </div>
                  <h3 class="digest-index-period">
                    <Show
                      when={digest.status === "complete"}
                      fallback={
                        <span>
                          <FormatTime ms={digest.periodStartMs} />{" "}
                          <span aria-hidden="true">—</span>{" "}
                          <FormatTime ms={digest.periodEndMs} />
                        </span>
                      }
                    >
                      <a href={`/issues/${encodeURIComponent(digest.id)}`}>
                        <FormatTime ms={digest.periodStartMs} />{" "}
                        <span aria-hidden="true">—</span>{" "}
                        <FormatTime ms={digest.periodEndMs} />
                        <span class="sr-only">, read digest</span>
                      </a>
                    </Show>
                  </h3>
                  <dl class="digest-index-meta">
                    <div>
                      <dt>Latest request</dt>
                      <dd class="digest-index-request">
                        <FormatTime
                          ms={digest.latestRunStartedAt ?? digest.createdAt}
                        />
                      </dd>
                    </div>
                    <Show when={digest.latestRunStartedAt && digest.latestRunFinishedAt}>
                      <div>
                        <dt>Preparation</dt>
                        <dd>
                          {formatDuration(
                            digest.latestRunFinishedAt! - digest.latestRunStartedAt!,
                          )}
                        </dd>
                      </div>
                    </Show>
                  </dl>
                  <Show when={digest.status === "pending"}>
                    <p class="digest-index-note" role="status">
                      This briefing is being prepared. It will appear here when
                      the run finishes.
                    </p>
                  </Show>
                  <Show when={digest.status === "failed"}>
                    <p class="digest-index-note digest-index-note-error" role="status">
                      The latest request did not finish. Review runs in Profile
                      for technical details, then try again when ready.
                    </p>
                  </Show>
                </div>
                <details class="digest-row-actions">
                  <summary>Issue actions</summary>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => void handleDelete(digest.id)}
                    disabled={deletingId() === digest.id}
                  >
                    {deletingId() === digest.id ? "Deleting…" : "Delete digest"}
                  </button>
                </details>
              </article>
            )}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <div class="error" role="alert">{error()}</div>
      </Show>

      <Show when={props.nextCursor}>
        <div class="digest-index-more">
          <button
            type="button"
            onClick={() => void props.onLoadMore?.()}
            disabled={props.loadingMore}
          >
            {props.loadingMore ? "Loading archive…" : "Load more issues"}
          </button>
        </div>
      </Show>
    </section>
  );
}
