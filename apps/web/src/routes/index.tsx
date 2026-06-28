import { createSignal, Show, onMount } from "solid-js";
import { getCurrentUser } from "../api/client";
import type { PublicUser } from "../api/types";
import AuthPanel from "../app/AuthPanel";
import Dashboard from "../app/Dashboard";

export default function HomePage() {
  const [user, setUser] = createSignal<PublicUser | null>(null);
  const [authChecked, setAuthChecked] = createSignal(false);

  onMount(async () => {
    try {
      const u = await getCurrentUser();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setAuthChecked(true);
    }
  });

  const handleLogin = (u: PublicUser) => {
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
            user={u()}
            onLogout={handleLogout}
            onAuthError={handleAuthError}
            onUserUpdate={setUser}
          />
        )}
      </Show>
    </Show>
  );
}
