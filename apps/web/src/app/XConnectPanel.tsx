import { createSignal, Show } from "solid-js";
import { ApiClientError, connectXSession } from "../api/client";
import type { PublicSource } from "../api/types";

interface XConnectPanelProps {
  sources: PublicSource[];
  onConnected: () => Promise<void>;
  onAuthError: () => void;
}

function safeError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) return error.message;
  return fallback;
}

export default function XConnectPanel(props: XConnectPanelProps) {
  const [apiKey, setApiKey] = createSignal("");
  const [authToken, setAuthToken] = createSignal("");
  const [cookie, setCookie] = createSignal("");
  const [pin, setPin] = createSignal("");
  const [listQuery, setListQuery] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  const connectedSource = () =>
    props.sources.find(
      (source) => source.connectorId === "X" && source.connected,
    );
  const hasXSource = () => props.sources.some((source) => source.connectorId === "X");

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (loading()) return;

    const cookieValue = cookie().trim();
    if (!cookieValue) {
      setError("Complete X Cookie header value is required.");
      setSuccess(null);
      return;
    }

    setError(null);
    setSuccess(null);
    setLoading(true);

    const input = {
      apiKey: apiKey().trim(),
      authToken: authToken().trim(),
      cookie: cookieValue,
      ...(pin().trim() ? { pin: pin().trim() } : {}),
      ...(listQuery().trim() ? { listQuery: listQuery().trim() } : {}),
    };

    try {
      await connectXSession(input);
      // Clear credentials before rendering success or refreshing the source list.
      setApiKey("");
      setAuthToken("");
      setCookie("");
      setPin("");
      setSuccess(
        "X is connected. Your credentials are encrypted at rest; discover Lists and XChat groups in Sources.",
      );
      await props.onConnected();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setError(safeError(err, "X could not be connected. Check the credentials and try again."));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      class="card"
      aria-busy={loading()}
    >
      <div class="card-header">
        <h2>Connect X with TwexAPI</h2>
      </div>

      <p class="hint x-connect-intro">
        Enter a TwexAPI key, the X <code>auth_token</code> for account validation,
        and the complete X Cookie header value required for XChat. Morning Post
        encrypts these credentials at rest and never displays them after a
        successful connection.
      </p>

      <div class="x-connect-safety" role="note">
        <strong>What you will need</strong>
        <ul class="bullet-list">
          <li>
            Your TwexAPI key and X <code>auth_token</code>. Keep the{" "}
            <code>auth_token</code> separate because it is used to validate your
            account; do not enter your X password or a 2FA code.
          </li>
          <li>
            The complete X Cookie header value for XChat, including matching{" "}
            <code>auth_token</code> and non-empty <code>ct0</code> cookie pairs.
            Paste the full header value as copied from X.
          </li>
          <li>
            An XChat PIN is optional. Leave it blank to use TwexAPI&apos;s
            default <code>1234</code>. It is sent only when reading group
            message history, not when discovering conversations.
          </li>
          <li>
            List discovery is search-based because TwexAPI does not provide an
            owned-lists endpoint. Leave the list-search query blank to search
            with your connected X username.
          </li>
        </ul>
      </div>

      <Show when={connectedSource()}>
        <p class="hint x-connect-status" role="status" aria-live="polite">
          X is connected. Use Sources to discover and subscribe to Lists and
          XChat groups.
        </p>
      </Show>

      <form onSubmit={handleSubmit} autocomplete="off">
        <div class="form-group">
          <label for="x-api-key">TwexAPI key</label>
          <input
            id="x-api-key"
            name="apiKey"
            type="password"
            autocomplete="off"
            required
            value={apiKey()}
            onInput={(event) => setApiKey(event.currentTarget.value)}
            aria-describedby="x-api-key-help"
            disabled={loading()}
          />
          <p id="x-api-key-help" class="hint">
            The API key issued by TwexAPI.
          </p>
        </div>

        <div class="form-group">
          <label for="x-auth-token">X <code>auth_token</code></label>
          <input
            id="x-auth-token"
            name="authToken"
            type="password"
            autocomplete="off"
            required
            value={authToken()}
            onInput={(event) => setAuthToken(event.currentTarget.value)}
            aria-describedby="x-auth-token-help"
            disabled={loading()}
          />
          <p id="x-auth-token-help" class="hint">
            Copy the <code>auth_token</code> value from your X cookie.
          </p>
        </div>

        <div class="form-group">
          <label for="x-cookie">Complete X Cookie header value</label>
          <input
            id="x-cookie"
            name="cookie"
            type="password"
            autocomplete="new-password"
            maxlength={16384}
            spellcheck={false}
            autocapitalize="off"
            required
            value={cookie()}
            onInput={(event) => setCookie(event.currentTarget.value)}
            aria-describedby="x-cookie-help"
            disabled={loading()}
          />
          <p id="x-cookie-help" class="hint">
            Paste the complete Cookie header value from X, including the{" "}
            <code>auth_token</code> value that matches the field above and a
            non-empty <code>ct0</code>. This is required for XChat.
          </p>
        </div>
        <div class="form-group">
          <label for="xchat-pin">XChat PIN <span class="hint">(optional)</span></label>
          <input
            id="xchat-pin"
            name="pin"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            value={pin()}
            onInput={(event) => setPin(event.currentTarget.value)}
            aria-describedby="xchat-pin-help"
            disabled={loading()}
          />
          <p id="xchat-pin-help" class="hint">
            Optional for message history. Leave blank to use TwexAPI&apos;s
            default PIN, <code>1234</code>; conversation discovery does not use it.
          </p>
        </div>

        <div class="form-group">
          <label for="x-list-query">List-search query <span class="hint">(optional)</span></label>
          <input
            id="x-list-query"
            name="listQuery"
            type="text"
            autocomplete="off"
            value={listQuery()}
            onInput={(event) => setListQuery(event.currentTarget.value)}
            aria-describedby="x-list-query-help"
            disabled={loading()}
          />
          <p id="x-list-query-help" class="hint">
            Search text for Lists. Blank uses the connected X username.
          </p>
        </div>

        <div class="form-actions">
          <button type="submit" class="primary" disabled={loading()}>
            {loading()
              ? "Connecting…"
              : hasXSource()
                ? "Reconnect X"
                : "Connect X"}
          </button>
        </div>
      </form>

      <Show when={success()}>
        <p class="hint" role="status" aria-live="polite">{success()}</p>
      </Show>
      <Show when={error()}>
        <p class="error" role="alert">{error()}</p>
      </Show>
    </div>
  );
}
