import { createSignal, onMount, Show } from "solid-js";
import {
  ApiClientError,
  getSetupStatus,
  loginUser,
  setupOwner,
} from "../api/client";
import type { PublicUser, SetupStatus } from "../api/types";

interface AuthPanelProps {
  onLogin: (user: PublicUser) => void;
}

export default function AuthPanel(props: AuthPanelProps) {
  const [setupStatus, setSetupStatus] = createSignal<SetupStatus | null>(null);
  const [statusError, setStatusError] = createSignal<string | null>(null);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");

  const setupRequired = () => setupStatus()?.setupRequired === true;
  const passwordRequired = () =>
    setupStatus()?.setupRequired === false &&
    setupStatus()?.passwordRequired === true;

  const loadSetupStatus = async () => {
    setStatusError(null);
    setSubmitError(null);
    setSetupStatus(null);

    try {
      setSetupStatus(await getSetupStatus());
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
    const status = setupStatus();
    if (loading() || status === null) return;

    setSubmitError(null);
    setLoading(true);

    try {
      let user: PublicUser;
      if (status.setupRequired) {
        user = await setupOwner({ name: name() });
      } else if (status.passwordRequired) {
        user = await loginUser({ password: password() });
      } else {
        user = await loginUser({});
      }
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
          when={setupStatus() !== null}
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
            fallback={
              <Show
                when={passwordRequired()}
                fallback={
                  <>
                    <h2>Welcome back</h2>
                    <p>Continue to your Morning Post.</p>
                  </>
                }
              >
                <h2>Sign in</h2>
              </Show>
            }
          >
            <h2>Welcome to Morning Post</h2>
            <p>Choose the name shown in your digests.</p>
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

            <Show when={passwordRequired()}>
              <div class="form-group">
                <label for="auth-password">Password</label>
                <input
                  id="auth-password"
                  type="password"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  required
                  disabled={loading()}
                  autocomplete="current-password"
                />
              </div>
            </Show>

            <div class="form-actions">
              <button type="submit" class="primary" disabled={loading()}>
                {loading()
                  ? "Please wait…"
                  : setupRequired()
                    ? "Get started"
                    : passwordRequired()
                      ? "Sign in"
                      : "Continue"}
              </button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
