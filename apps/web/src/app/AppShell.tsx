import {
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { PublicUser } from "../api/types";

export type AppSection =
  | "digests"
  | "connections"
  | "sources"
  | "feeds"
  | "profile";

type ThemePreference = "system" | "light" | "dark";

export interface AppShellProps {
  user?: PublicUser | null;
  activeSection: AppSection;
  onSectionChange?: (section: AppSection) => void;
  onLogout?: () => void;
  children: JSX.Element;
  wide?: boolean;
}

const sections: readonly { id: AppSection; label: string; note: string }[] = [
  { id: "digests", label: "Digests", note: "Read your latest briefing" },
  {
    id: "connections",
    label: "Connections",
    note: "Connect accounts and services",
  },
  { id: "sources", label: "Sources", note: "Arrange your publications" },
  { id: "feeds", label: "Feeds", note: "Tune individual feeds" },
  { id: "profile", label: "Profile", note: "Adjust your reading desk" },
];

const themeLabels: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function readStoredTheme(): ThemePreference {
  try {
    const value = window.localStorage.getItem("morning-post-theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: ThemePreference) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function persistTheme(theme: ThemePreference) {
  try {
    if (theme === "system") {
      window.localStorage.removeItem("morning-post-theme");
    } else {
      window.localStorage.setItem("morning-post-theme", theme);
    }
  } catch {
    // A blocked storage area should not prevent theme switching for this visit.
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "M";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function ThemeGlyph(props: { theme: ThemePreference }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
    >
      <Show when={props.theme === "light"} fallback={
        <Show when={props.theme === "dark"} fallback={<>
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
        </>}>
          <path d="M20 15.3A8.5 8.5 0 0 1 8.7 4 8.5 8.5 0 1 0 20 15.3Z" />
        </Show>
      }>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </Show>
    </svg>
  );
}

export default function AppShell(props: AppShellProps) {
  const [theme, setTheme] = createSignal<ThemePreference>("system");
  const [mounted, setMounted] = createSignal(false);

  onMount(() => {
    const storedTheme = readStoredTheme();
    setTheme(storedTheme);
    applyTheme(storedTheme);
    setMounted(true);

    // Keep the explicit system mode in sync with OS changes without writing a
    // preference. CSS also handles this before JavaScript has mounted.
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
    const handleSystemThemeChange = () => {
      if (theme() === "system") applyTheme("system");
    };
    media?.addEventListener?.("change", handleSystemThemeChange);
    onCleanup(() => media?.removeEventListener?.("change", handleSystemThemeChange));
  });

  const cycleTheme = () => {
    const next: ThemePreference =
      theme() === "system" ? "light" : theme() === "light" ? "dark" : "system";
    setTheme(next);
    persistTheme(next);
    applyTheme(next);
  };

  const themeLabel = () => (mounted() ? themeLabels[theme()] : themeLabels.system);
  const currentUserName = () => props.user?.name?.trim() || "Reader";

  return (
    <div class="app-shell">
      <header class="app-masthead">
        <div class="app-masthead-inner">
          <a class="app-brand" href="/" aria-label="Morning Post home">
            <span class="app-brand-mark" aria-hidden="true">M</span>
            <span class="app-brand-copy">
              <span class="app-brand-name">Morning Post</span>
              <span class="app-brand-tagline">Your daily briefing, made personal</span>
            </span>
          </a>

          <div class="app-account">
            <div class="app-account-copy">
              <span class="app-account-name">{currentUserName()}</span>
              <span class="app-account-caption">Your reading desk</span>
            </div>
            <span class="app-account-avatar" aria-hidden="true">
              {initials(currentUserName())}
            </span>
            <div class="app-account-actions">
              <button
                type="button"
                class="app-theme-toggle"
                onClick={cycleTheme}
                aria-label={`Switch theme (currently ${themeLabel()})`}
                title="Cycle system, light, and dark themes"
              >
                <ThemeGlyph theme={mounted() ? theme() : "system"} />
                <span>Theme: {themeLabel()}</span>
              </button>
              <Show when={props.onLogout}>
                <button type="button" class="app-logout" onClick={props.onLogout}>
                  Log out
                </button>
              </Show>
            </div>
          </div>
        </div>

        <div class="app-nav-band">
          <div class="app-nav-inner">
            <nav class="app-nav" aria-label="Primary navigation">
              {sections.map((section) => (
                <button
                  type="button"
                  class="app-nav-link"
                  aria-current={props.activeSection === section.id ? "page" : undefined}
                  title={section.note}
                  onClick={() => props.onSectionChange?.(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main class={`app-container${props.wide ? " app-container-wide" : ""}`}>
        {props.children}
      </main>
    </div>
  );
}

export { AppShell };
