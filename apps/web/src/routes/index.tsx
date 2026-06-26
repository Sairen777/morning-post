import { createSignal, Show, onMount } from "solid-js";
import { getCurrentUser, ApiClientError } from "../api/client";
import AuthPanel from "../app/AuthPanel";
import Dashboard from "../app/Dashboard";

export default function HomePage() {
  const [user, setUser] = createSignal<{ id: string; email: string } | null>(
    null,
  );
  const [authChecked, setAuthChecked] = createSignal(false);

  onMount(async () => {
    try {
      const u = await getCurrentUser();
      setUser({ id: u.id, email: u.email });
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        setUser(null);
      }
    } finally {
      setAuthChecked(true);
    }
  });

  const handleLogin = (u: { id: string; email: string }) => {
    setUser(u);
    setAuthChecked(true);
  };

  const handleLogout = () => {
    setUser(null);
  };

  const handleAuthError = () => {
    setUser(null);
  };

  return (
    <Show when={authChecked()} fallback={<p>Loading…</p>}>
      <Show
        when={user()}
        fallback={<AuthPanel onLogin={handleLogin} />}
      >
        {(u) => (
          <Dashboard
            user={{ id: u().id, email: u().email }}
            onLogout={handleLogout}
            onAuthError={handleAuthError}
          />
        )}
      </Show>
    </Show>
  );
}
