import { createSignal, Show } from "solid-js";
import type { PublicSource } from "../api/types";
import {
  addSubstackPublication,
  ApiClientError,
  connectSubstackSession,
} from "../api/client";

interface SubstackConnectPanelProps {
  sources: PublicSource[];
  onConnected: () => Promise<void>;
  onPublicationAdded: () => Promise<void>;
  onAuthError: () => void;
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) return error.message;
  return fallback;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

export default function SubstackConnectPanel(props: SubstackConnectPanelProps) {
  const [substackSessionId, setSubstackSessionId] = createSignal("");
  const [connectSessionId, setConnectSessionId] = createSignal("");
  const [publicationUrl, setPublicationUrl] = createSignal("");
  const [loading, setLoading] = createSignal<"session" | "publication" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  const connectedSource = () => props.sources.find(
    (source) => source.connectorId === "Substack" && source.connected,
  );
  const hasSubstackSource = () => props.sources.some((source) => source.connectorId === "Substack");

  const handleSessionSubmit = async (event: Event) => {
    event.preventDefault();
    if (loading()) return;
    setError(null);
    setSuccess(null);
    setLoading("session");
    try {
      const sid = substackSessionId();
      const connectSid = connectSessionId();
      const input = connectSid
        ? { substackSessionId: sid, connectSessionId: connectSid }
        : { substackSessionId: sid };
      await connectSubstackSession(input);
      // Clear secrets before invoking any refresh callback or rendering success UI.
      setSubstackSessionId("");
      setConnectSessionId("");
      setSuccess("Substack session connected. Your session credentials are encrypted at rest.");
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
        Substack has no supported private-post API. This is an unsupported integration that uses
        full-account browser session credentials, encrypted at rest, and may need replacement when
        Substack expires them. Never enter your Substack password or a raw Cookie header.
      </p>
      <details style="margin: 0.75rem 0;">
        <summary>How to find session credentials</summary>
        <p class="hint">
          In DevTools, open Application, then Cookies, select the Substack site, and copy the value
          of <code>substack.sid</code>. Paste the complete value here; do not copy a password or
          the Cookie header.
        </p>
      </details>

      <form onSubmit={handleSessionSubmit}>
        <div class="form-group">
          <label for="substack-session-id">substack.sid session credential</label>
          <input
            id="substack-session-id"
            type="password"
            autocomplete="off"
            required
            value={substackSessionId()}
            onInput={(event) => setSubstackSessionId(event.currentTarget.value)}
          />
        </div>
        <details>
          <summary>Optional connect.sid compatibility credential</summary>
          <div class="form-group" style="margin-top: 0.5rem;">
            <label for="connect-session-id">connect.sid compatibility credential</label>
            <input
              id="connect-session-id"
              type="password"
              autocomplete="off"
              value={connectSessionId()}
              onInput={(event) => setConnectSessionId(event.currentTarget.value)}
            />
          </div>
        </details>
        <button type="submit" class="primary" disabled={loading() !== null}>
          {loading() === "session"
            ? "Saving session…"
            : hasSubstackSource()
              ? "Replace Substack session"
              : "Connect Substack"}
        </button>
      </form>

      <Show when={connectedSource()}>
        <form onSubmit={handlePublicationSubmit} style="margin-top: 1.5rem;">
          <h3>Add a publication</h3>
          <p class="hint">Add each publication manually. Discovery is intentionally unavailable for Substack.</p>
          <div class="form-group">
            <label for="substack-publication-url">Publication URL</label>
            <input
              id="substack-publication-url"
              type="url"
              autocomplete="url"
              placeholder="https://example.substack.com"
              required
              value={publicationUrl()}
              onInput={(event) => setPublicationUrl(event.currentTarget.value)}
            />
          </div>
          <button type="submit" disabled={loading() !== null}>
            {loading() === "publication" ? "Adding publication…" : "Add publication"}
          </button>
        </form>
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
