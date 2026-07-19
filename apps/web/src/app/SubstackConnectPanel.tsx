import { createSignal, For, Show } from "solid-js";
import type { AvailableFeed, PublicFeed, PublicSource } from "../api/types";
import {
  addSubstackPublication,
  ApiClientError,
  connectSubstackSession,
  listSubstackPublications,
} from "../api/client";

interface SubstackConnectPanelProps {
  sources: PublicSource[];
  feeds: PublicFeed[];
  onConnected: () => Promise<void>;
  onPublicationAdded: () => Promise<void>;
  onAuthError: () => void;
}

type DiscoveryState = "untouched" | "loading" | "loaded" | "empty" | "error";

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) return error.message;
  return fallback;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname.length > 0 &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

function publicationDomain(publication: AvailableFeed): string {
  try {
    return new URL(publication.externalId).hostname;
  } catch {
    return publication.externalId;
  }
}

export default function SubstackConnectPanel(props: SubstackConnectPanelProps) {
  const [substackSessionId, setSubstackSessionId] = createSignal("");
  const [connectSessionId, setConnectSessionId] = createSignal("");
  const [publicationUrl, setPublicationUrl] = createSignal("");
  const [loading, setLoading] = createSignal<"session" | "publication" | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [discoveryState, setDiscoveryState] = createSignal<DiscoveryState>(
    "untouched",
  );
  const [discoveredPublications, setDiscoveredPublications] = createSignal<
    AvailableFeed[]
  >([]);
  const [discoveryError, setDiscoveryError] = createSignal<string | null>(null);
  const [addingExternalIds, setAddingExternalIds] = createSignal<string[]>([]);
  const [addedExternalIds, setAddedExternalIds] = createSignal<string[]>([]);
  let publicationAccountGeneration = 0;

  const connectedSource = () =>
    props.sources.find(
      (source) => source.connectorId === "Substack" && source.connected,
    );
  const hasSubstackSource = () =>
    props.sources.some((source) => source.connectorId === "Substack");
  const isPublicationAdded = (publication: AvailableFeed) => {
    const sourceId = connectedSource()?.id;
    return (
      sourceId !== undefined &&
      props.feeds.some((feed) =>
        feed.sourceId === sourceId && feed.externalId === publication.externalId
      )
    ) || addedExternalIds().includes(publication.externalId);
  };
  const resetDiscovery = () => {
    publicationAccountGeneration += 1;
    setDiscoveryState("untouched");
    setDiscoveredPublications([]);
    setDiscoveryError(null);
    setAddingExternalIds([]);
    setAddedExternalIds([]);
  };

  const handleSessionSubmit = async (event: Event) => {
    event.preventDefault();
    if (loading()) return;
    setError(null);
    setSuccess(null);
    setLoading("session");
    try {
      const input = connectSessionId()
        ? {
          substackSessionId: substackSessionId(),
          connectSessionId: connectSessionId(),
        }
        : { substackSessionId: substackSessionId() };
      await connectSubstackSession(input);
      // Clear secrets before invoking any refresh callback or rendering success UI.
      setSubstackSessionId("");
      setConnectSessionId("");
      resetDiscovery();
      setSuccess(
        "Substack session connected. Your session credentials are encrypted at rest.",
      );
      await props.onConnected();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "Substack session could not be connected."));
      }
    } finally {
      setLoading(null);
    }
  };

  const handleDiscoverPublications = async () => {
    if (discoveryState() === "loading") return;
    const requestGeneration = publicationAccountGeneration;
    setDiscoveryError(null);
    setDiscoveryState("loading");
    try {
      const publications = await listSubstackPublications();
      if (requestGeneration !== publicationAccountGeneration) return;
      setDiscoveredPublications(publications);
      setDiscoveryState(publications.length > 0 ? "loaded" : "empty");
    } catch (err: unknown) {
      if (requestGeneration !== publicationAccountGeneration) return;
      if (err instanceof ApiClientError && err.status === 401) {
        setDiscoveryState("error");
        props.onAuthError();
        return;
      }
      setDiscoveryError(
        safeError(err, "Followed publications could not be loaded."),
      );
      setDiscoveryState("error");
    }
  };

  const handleAddDiscoveredPublication = async (publication: AvailableFeed) => {
    if (
      addingExternalIds().includes(publication.externalId) ||
      isPublicationAdded(publication)
    ) return;
    const requestGeneration = publicationAccountGeneration;
    setDiscoveryError(null);
    setSuccess(null);
    setAddingExternalIds((previous) => [...previous, publication.externalId]);
    try {
      await addSubstackPublication({ publicationUrl: publication.externalId });
      if (requestGeneration === publicationAccountGeneration) {
        setAddedExternalIds((previous) =>
          previous.includes(publication.externalId)
            ? previous
            : [...previous, publication.externalId]
        );
        setSuccess(`${publication.name} added.`);
      }
      await props.onPublicationAdded();
    } catch (err: unknown) {
      if (requestGeneration !== publicationAccountGeneration) return;
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setDiscoveryError(safeError(err, "Publication could not be added."));
      }
    } finally {
      if (requestGeneration === publicationAccountGeneration) {
        setAddingExternalIds((previous) =>
          previous.filter((externalId) => externalId !== publication.externalId)
        );
      }
    }
  };

  const handlePublicationSubmit = async (event: Event) => {
    event.preventDefault();
    if (loading()) return;
    setError(null);
    setSuccess(null);
    const value = publicationUrl().trim();
    if (!isHttpsUrl(value)) {
      setError("Enter a valid HTTPS publication URL.");
      return;
    }
    setLoading("publication");
    try {
      await addSubstackPublication({ publicationUrl: value });
      setPublicationUrl("");
      setSuccess("Publication added.");
      await props.onPublicationAdded();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "Publication could not be added."));
      }
    } finally {
      setLoading(null);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Substack Connection</h2>
      </div>
      <p class="hint">
        Substack has no supported private-post API. This is an unsupported
        integration that uses full-account browser session credentials,
        encrypted at rest, and may need replacement when Substack expires them.
        Never enter your Substack password or a raw Cookie header.
      </p>
      <details style="margin: 0.75rem 0;">
        <summary>How to find session credentials</summary>
        <p class="hint">
          In DevTools, open Application, then Cookies, select the Substack site,
          and copy the complete value of{" "}
          <code>substack.sid</code>. If your browser also has
          <code>connect.sid</code>, you may provide it below. Do not copy a
          password or the Cookie header.
        </p>
      </details>

      <form onSubmit={handleSessionSubmit}>
        <div class="form-group">
          <label for="substack-session-id">
            substack.sid session credential
          </label>
          <input
            id="substack-session-id"
            type="password"
            autocomplete="off"
            required
            value={substackSessionId()}
            onInput={(event) => setSubstackSessionId(event.currentTarget.value)}
          />
        </div>
        <div class="form-group">
          <label for="connect-session-id">
            connect.sid session credential (optional)
          </label>
          <input
            id="connect-session-id"
            type="password"
            autocomplete="off"
            value={connectSessionId()}
            onInput={(event) => setConnectSessionId(event.currentTarget.value)}
          />
        </div>
        <button type="submit" class="primary" disabled={loading() !== null}>
          {loading() === "session"
            ? "Saving session…"
            : hasSubstackSource()
            ? "Replace Substack session"
            : "Connect Substack"}
        </button>
      </form>

      <Show when={connectedSource()}>
        <section
          class="substack-discovery"
          aria-labelledby="substack-discovery-title"
          aria-busy={discoveryState() === "loading"}
        >
          <div class="substack-discovery-header">
            <div>
              <h3 id="substack-discovery-title">Followed publications</h3>
              <p class="hint">
                Use your Substack account to find publications you already
                follow.
              </p>
            </div>
            <button
              type="button"
              class="primary"
              onClick={handleDiscoverPublications}
              disabled={discoveryState() === "loading"}
            >
              {discoveryState() === "loading"
                ? "Finding publications…"
                : "Find followed publications"}
            </button>
          </div>

          <Show when={discoveryState() === "loaded"}>
            <div class="publication-list" aria-label="Followed publications">
              <For each={discoveredPublications()}>
                {(publication) => (
                  <article class="publication-row">
                    <div class="publication-details">
                      <h4>{publication.name}</h4>
                      <a
                        class="publication-domain"
                        href={publication.externalId}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {publicationDomain(publication)}
                      </a>
                    </div>
                    <Show
                      when={!isPublicationAdded(publication)}
                      fallback={
                        <button
                          type="button"
                          aria-label={`Added ${publication.name}`}
                          disabled
                        >
                          Added
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="publication-action"
                        aria-label={`${
                          addingExternalIds().includes(publication.externalId)
                            ? "Adding"
                            : "Add"
                        } ${publication.name}`}
                        disabled={addingExternalIds().includes(
                          publication.externalId,
                        )}
                        onClick={() =>
                          handleAddDiscoveredPublication(publication)}
                      >
                        {addingExternalIds().includes(publication.externalId)
                          ? "Adding…"
                          : "Add"}
                      </button>
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>
          <Show when={discoveryState() === "empty"}>
            <p class="substack-discovery-empty" role="status">
              No followed publications were found in this Substack account.
            </p>
          </Show>
          <Show when={discoveryError()}>
            <p class="error" role="alert">{discoveryError()}</p>
          </Show>
        </section>

        <section
          class="substack-manual"
          aria-labelledby="substack-manual-title"
        >
          <h3 id="substack-manual-title">Add another publication</h3>
          <p class="hint">
            Have a publication that is not in your followed list? Add its URL
            here.
          </p>
          <form onSubmit={handlePublicationSubmit}>
            <div class="form-group">
              <label for="substack-publication-url">Publication URL</label>
              <input
                id="substack-publication-url"
                type="url"
                autocomplete="url"
                placeholder="https://example.substack.com"
                required
                value={publicationUrl()}
                onInput={(event) =>
                  setPublicationUrl(event.currentTarget.value)}
              />
            </div>
            <button type="submit" disabled={loading() !== null}>
              {loading() === "publication"
                ? "Adding publication…"
                : "Add publication"}
            </button>
          </form>
        </section>
      </Show>

      <Show when={success()}>
        <p class="hint" role="status">{success()}</p>
      </Show>
      <Show when={error()}>
        <p class="error" role="alert">{error()}</p>
      </Show>
    </div>
  );
}
