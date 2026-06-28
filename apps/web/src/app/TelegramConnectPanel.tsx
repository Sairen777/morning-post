import { createSignal, onCleanup, Show } from "solid-js";
import QRCode from "qrcode";
import type { PublicSource, TelegramLoginStatus } from "../api/types";
import {
  startTelegramLogin,
  getTelegramLoginStatus,
  submitTelegramTwoFactorAuthentication,
  ApiClientError,
} from "../api/client";
import StatusBadge from "./StatusBadge";
import FormatTime from "./FormatTime";

interface TelegramConnectPanelProps {
  sources: PublicSource[];
  onConnected: () => Promise<void>;
  onAuthError: () => void;
}

export default function TelegramConnectPanel(props: TelegramConnectPanelProps) {
  const [loginSessionId, setLoginSessionId] = createSignal<string | null>(null);
  const [qrUrl, setQrUrl] = createSignal<string | null>(null);
  const [qrImageDataUrl, setQrImageDataUrl] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<TelegramLoginStatus | null>(null);
  const [expiresAt, setExpiresAt] = createSignal<number | null>(null);
  const [twoFactorPassword, setTwoFactorPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const hasTelegramSource = () =>
    props.sources.some((s) => s.connectorId === "Telegram");

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const pollStatus = async () => {
    const sid = loginSessionId();
    if (!sid) return;

    try {
      const result = await getTelegramLoginStatus(sid);
      setStatus(result.status);
      setExpiresAt(result.expiresAt);

      if (result.errorMessage) {
        setError(result.errorMessage);
      }

      if (
        result.status === "complete" ||
        result.status === "error" ||
        result.status === "expired"
      ) {
        stopPolling();
        if (result.status === "complete") {
          await props.onConnected();
        }
      }
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(pollStatus, 2000);
  };

  onCleanup(() => {
    stopPolling();
  });

  const handleStart = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await startTelegramLogin();
      setLoginSessionId(result.loginSessionId);
      setQrUrl(result.qrUrl);
      setStatus("pending");
      setExpiresAt(result.expiresAt);

      try {
        const dataUrl = await QRCode.toDataURL(result.qrUrl, {
          errorCorrectionLevel: "M",
          margin: 2,
          scale: 8,
        });
        setQrImageDataUrl(dataUrl);
      } catch {
        setQrImageDataUrl(null);
        setError("QR code generation failed. Use the raw URL or Open Telegram link below.");
      }

      startPolling();
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to start Telegram login");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopyUrl = async () => {
    const url = qrUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setError("Failed to copy URL to clipboard");
    }
  };

  const handleSubmit2FA = async (e: Event) => {
    e.preventDefault();
    const sid = loginSessionId();
    if (!sid) return;

    setError(null);
    setLoading(true);
    try {
      const result = await submitTelegramTwoFactorAuthentication(sid, {
        password: twoFactorPassword(),
      });
      setStatus(result.status);
      setExpiresAt(result.expiresAt);

      if (result.errorMessage) {
        setError(result.errorMessage);
      }

      if (result.status === "complete") {
        stopPolling();
        await props.onConnected();
      } else if (result.status === "error") {
        stopPolling();
      }
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("2FA submission failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Telegram Connection</h2>
      </div>

      <Show
        when={loginSessionId()}
        fallback={
          <div>
            <button
              onClick={handleStart}
              disabled={loading()}
              class="primary"
            >
              {loading()
                ? "Starting…"
                : hasTelegramSource()
                  ? "Reconnect Telegram"
                  : "Connect Telegram"}
            </button>
          </div>
        }
      >
        <div class="form-group">
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>

          <Show when={qrImageDataUrl()}>
            <img
              alt="Telegram login QR code"
              src={qrImageDataUrl()!}
              style="max-width: 300px; display: block; margin: 1rem 0;"
            />
          </Show>

          <div class="form-group">
            <label>Login URL</label>
            <textarea
              value={qrUrl() ?? ""}
              readonly
              rows={2}
              style="width: 100%;"
            />
            <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem;">
              <button type="button" onClick={handleCopyUrl}>
                Copy URL
              </button>
              <Show when={qrUrl()}>
                <a
                  href={qrUrl()!}
                  target="_blank"
                  rel="noopener noreferrer"
                  style="display: inline-flex; align-items: center;"
                >
                  Open Telegram
                </a>
              </Show>
            </div>
          </div>

          <div class="meta-row">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={status() ?? "pending"} />
            </dd>
          </div>

          <Show when={expiresAt() !== null}>
            <div class="meta-row">
              <dt>Expires</dt>
              <dd>
                <FormatTime ms={expiresAt()!} />
              </dd>
            </div>
          </Show>

          <Show when={status() === "needs_2fa"}>
            <form onSubmit={handleSubmit2FA}>
              <div class="form-group">
                <label for="tcp-2fa-password">Two-factor password</label>
                <input
                  id="tcp-2fa-password"
                  type="password"
                  value={twoFactorPassword()}
                  onInput={(e) => setTwoFactorPassword(e.currentTarget.value)}
                  required
                />
              </div>
              <button type="submit" disabled={loading()}>
                {loading() ? "Submitting…" : "Submit 2FA password"}
              </button>
            </form>
          </Show>
        </div>
      </Show>
    </div>
  );
}
