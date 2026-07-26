import { createSignal, onMount, Show } from "solid-js";
import {
  ApiClientError,
  getSetupStatus,
  loginUser,
  setupOwner,
} from "../api/client";
import type { PublicUser } from "../api/types";

interface AuthPanelProps {
  onLogin: (user: PublicUser) => void;
}

export default function AuthPanel(props: AuthPanelProps) {
  const [setupRequired, setSetupRequired] = createSignal<boolean | null>(null);
  const [statusError, setStatusError] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");

  const loadSetupStatus = async () => {
    setStatusError(null);
    setSubmitError(null);
    setSetupRequired(null);

    try {
      const status = await getSetupStatus();
      setSetupRequired(status.setupRequired);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setStatusError(err.message);
      } else {
        setStatusError("An unexpected error occurred");
      }
    }
  };

  onMount(loadSetupStatus);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (loading() || setupRequired() === null) return;

    setSubmitError(null);
    setLoading(true);

    try {
      const user = setupRequired()
        ? await setupOwner({ name: name(), password: password() })
        : await loginUser({ password: password() });
      props.onLogin(user);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("An unexpected error occurred");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="auth-panel">
      <div class="card">
        <h1>Morning Post</h1>

        <Show
          when={setupRequired() !== null}
          fallback={
            <Show
              when={statusError()}
              fallback={<p role="status">Checking setup status…</p>}
            >
              <div class="error" role="alert">{statusError()}</div>
              <button type="button" onClick={loadSetupStatus}>
                Try again
              </button>
            </Show>
          }
        >
          <Show when={submitError()}>
            <div class="error" role="alert">{submitError()}</div>
          </Show>

          <Show
            when={setupRequired()}
            fallback={<h2>Sign in</h2>}
          >
            <h2>Set up your owner account</h2>
          </Show>

          <form onSubmit={handleSubmit}>
            <Show when={setupRequired()}>
              <div class="form-group">
                <label for="auth-name">Name</label>
                <input
                  id="auth-name"
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  required
                  disabled={loading()}
                  autocomplete="name"
                />
              </div>
            </Show>

            <div class="form-group">
              <label for="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                required
                disabled={loading()}
                autocomplete={setupRequired() ? "new-password" : "current-password"}
              />
            </div>

            <div class="form-actions">
              <button type="submit" class="primary" disabled={loading()}>
                {loading()
                  ? "Please wait…"
                  : setupRequired()
                    ? "Create owner account"
                    : "Sign in"}
              </button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
