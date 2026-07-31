import { useParams } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";
import {
  ApiClientError,
  getCurrentUser,
  getDigest,
  logoutUser,
  submitStoryFeedback,
} from "../../api/client";
import type { DigestView, PublicUser, StoryFeedbackInput } from "../../api/types";
import AppShell, { type AppSection } from "../../app/AppShell";
import { DigestViewContent } from "../../app/DigestsPanel";
import FormatTime from "../../app/FormatTime";
import StatusBadge from "../../app/StatusBadge";

function formatDateline(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(ms);
}

export default function DigestReaderRoute() {
  const params = useParams<{ id: string }>();
  const [user, setUser] = createSignal<PublicUser | null>(null);
  const [view, setView] = createSignal<DigestView | null>(null);
  const [state, setState] = createSignal<
    "loading" | "ready" | "unauthorized" | "not_found" | "error"
  >("loading");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  const load = async () => {
    setState("loading");
    setErrorMessage(null);
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
      const digest = await getDigest(params.id);
      setView(digest);
      setState("ready");
    } catch (error: unknown) {
      const status = error instanceof ApiClientError
        ? error.status
        : error instanceof Error && "status" in error && typeof error.status === "number"
        ? error.status
        : undefined;
      if (status === 401) {
        setUser(null);
        setState("unauthorized");
      } else if (status === 404) {
        setState("not_found");
      } else {
        setState("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "We couldn't load this digest. Please try again.",
        );
      }
    }
  };

  onMount(() => {
    void load();
  });

  const handleLogout = async () => {
    try {
      await logoutUser();
    } finally {
      setUser(null);
      setView(null);
      setState("unauthorized");
    }
  };

  const handleAuthError = () => {
    setUser(null);
    setView(null);
    setState("unauthorized");
  };

  const submitFeedback = (storyId: string, input: StoryFeedbackInput) =>
    submitStoryFeedback(storyId, input);

  const navigateToSection = (section: AppSection) => {
    if (typeof window === "undefined") return;
    const target = section === "digests"
      ? "/"
      : `/?section=${encodeURIComponent(section)}`;
    window.location.assign(target);
  };
  return (
    <AppShell
      user={user()}
      activeSection="digests"
      onSectionChange={navigateToSection}
      onLogout={user() ? () => void handleLogout() : undefined}
    >
      <Show when={state() === "ready" && view()}>
        {(loadedView) => (
          <article class="digest-reader-page">
            <header class="digest-reader-header">
              <a class="digest-reader-back" href="/">
                <span aria-hidden="true">←</span> Back to archive
              </a>
              <p class="app-content-kicker">Morning Post / Digest</p>
              <h1>Your briefing</h1>
              <p class="digest-reader-dateline">
                Coverage:{" "}
                <time dateTime={new Date(loadedView().digest.periodStartMs).toISOString()}>
                  {formatDateline(loadedView().digest.periodStartMs)}
                </time>
                <span aria-hidden="true"> — </span>
                <time dateTime={new Date(loadedView().digest.periodEndMs).toISOString()}>
                  {formatDateline(loadedView().digest.periodEndMs)}
                </time>
              </p>
              <dl class="digest-reader-meta">
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    <FormatTime ms={loadedView().digest.periodStartMs} />
                    <span aria-hidden="true"> to </span>
                    <FormatTime ms={loadedView().digest.periodEndMs} />
                  </dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>
                    <FormatTime
                      ms={loadedView().digest.latestRunStartedAt ?? loadedView().digest.createdAt}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd><StatusBadge status={loadedView().digest.status} /></dd>
                </div>
              </dl>
            </header>
            <DigestViewContent
              view={loadedView()}
              reader
              onAuthError={handleAuthError}
              onSubmitFeedback={submitFeedback}
            />
          </article>
        )}
      </Show>

      <Show when={state() === "loading"}>
        <section class="reader-state" role="status" aria-live="polite">
          <p class="app-content-kicker">The archive</p>
          <h1>Opening your briefing</h1>
          <p>Loading the issue and checking your reading desk access…</p>
        </section>
      </Show>

      <Show when={state() === "unauthorized"}>
        <section class="reader-state" role="alert">
          <p class="app-content-kicker">Access required</p>
          <h1>Sign in to read this briefing</h1>
          <p>Your session may have expired. Return home to sign in again.</p>
          <a class="button-link primary" href="/">Return to Morning Post</a>
        </section>
      </Show>

      <Show when={state() === "not_found"}>
        <section class="reader-state" role="alert">
          <p class="app-content-kicker">Issue unavailable</p>
          <h1>That briefing is not in your archive</h1>
          <p>It may have been deleted, or the link may have expired.</p>
          <a class="button-link" href="/">Back to archive</a>
        </section>
      </Show>

      <Show when={state() === "error"}>
        <section class="reader-state" role="alert">
          <p class="app-content-kicker">A technical interruption</p>
          <h1>We couldn't open this briefing</h1>
          <p>{errorMessage() ?? "Please try again."}</p>
          <div class="control-row">
            <button type="button" class="primary" onClick={() => void load()}>
              Try again
            </button>
            <a class="button-link" href="/">Back to archive</a>
          </div>
        </section>
      </Show>
    </AppShell>
  );
}
