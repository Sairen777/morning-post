import { createSignal } from "solid-js";
import { loginUser, registerUser, ApiClientError } from "../api/client";

interface AuthPanelProps {
  onLogin: (user: { id: string; email: string }) => void;
}

export default function AuthPanel(props: AuthPanelProps) {
  const [mode, setMode] = createSignal<"login" | "register">("login");
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");

  const switchMode = () => {
    setError(null);
    setMode((m) => (m === "login" ? "register" : "login"));
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode() === "register") {
        await registerUser({
          name: name(),
          email: email(),
          password: password(),
        });
        const user = await loginUser({
          email: email(),
          password: password(),
        });
        props.onLogin({ id: user.id, email: user.email });
      } else {
        const user = await loginUser({
          email: email(),
          password: password(),
        });
        props.onLogin({ id: user.id, email: user.email });
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="auth-panel">
      <div class="card">
        <h1>Morning Post</h1>

        {error() && <div class="error">{error()}</div>}

        <form onSubmit={handleSubmit}>
          {mode() === "register" && (
            <div class="form-group">
              <label for="auth-name">Name</label>
              <input
                id="auth-name"
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                required
                disabled={loading()}
              />
            </div>
          )}

          <div class="form-group">
            <label for="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              required
              disabled={loading()}
              autocomplete="email"
            />
          </div>

          <div class="form-group">
            <label for="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
              disabled={loading()}
              autocomplete={
                mode() === "register" ? "new-password" : "current-password"
              }
            />
          </div>

          <div class="form-actions">
            <button type="submit" class="primary" disabled={loading()}>
              {loading()
                ? "Please wait…"
                : mode() === "register"
                  ? "Create account"
                  : "Sign in"}
            </button>
          </div>
        </form>

        <div class="auth-toggle">
          {mode() === "login" ? (
            <>
              Don't have an account?{" "}
              <a onClick={switchMode}>Register</a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a onClick={switchMode}>Sign in</a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
