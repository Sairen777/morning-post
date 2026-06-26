import {
  createSignal,
  Show,
  onMount,
} from "solid-js";
import {
  listSources,
  listFeeds,
  listDigests,
  updateSource,
  updateFeed,
  listAvailableFeeds,
  subscribeFeed,
  runDigest,
  getDigest,
  logoutUser,
  ApiClientError,
} from "../api/client";
import type {
  PublicSource,
  PublicFeed,
  PublicDigest,
  AvailableFeed,
  DigestView,
} from "../api/types";
import DigestRunnerCard from "./DigestRunnerCard";
import SourcesPanel from "./SourcesPanel";
import FeedsPanel from "./FeedsPanel";
import DigestsPanel from "./DigestsPanel";

interface DashboardProps {
  user: { id: string; email: string };
  onLogout: () => void;
  onAuthError: () => void;
}

type TabId = "digests" | "sources" | "feeds";

export default function Dashboard(props: DashboardProps) {
  const [activeTab, setActiveTab] = createSignal<TabId>("digests");

  // Data signals
  const [sources, setSources] = createSignal<PublicSource[]>([]);
  const [feeds, setFeeds] = createSignal<PublicFeed[]>([]);
  const [digests, setDigests] = createSignal<PublicDigest[]>([]);
  const [availableFeeds, setAvailableFeeds] = createSignal<
    Record<string, AvailableFeed[]>
  >({});

  // Fetch helpers
  const refreshSources = async () => {
    try {
      setSources(await listSources());
    } catch (err: unknown) {
      if (
        err instanceof ApiClientError &&
        err.status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  const refreshFeeds = async () => {
    try {
      setFeeds(await listFeeds());
    } catch (err: unknown) {
      if (
        err instanceof ApiClientError &&
        err.status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  const refreshDigests = async () => {
    try {
      setDigests(await listDigests());
    } catch (err: unknown) {
      if (
        err instanceof ApiClientError &&
        err.status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  onMount(() => {
    refreshSources();
    refreshFeeds();
    refreshDigests();
  });

  // Actions
  const handleToggleSource = async (id: string, enabled: boolean) => {
    await updateSource(id, { enabled });
    await refreshSources();
  };

  const handleDiscoverFeeds = async (
    sourceId: string,
  ): Promise<AvailableFeed[]> => {
    const result = await listAvailableFeeds(sourceId);
    setAvailableFeeds((prev) => ({ ...prev, [sourceId]: result }));
    return result;
  };

  const handleToggleFeed = async (id: string, enabled: boolean) => {
    await updateFeed(id, { enabled });
    await refreshFeeds();
  };

  const handleSubscribe = async (
    sourceId: string,
    feed: AvailableFeed,
  ) => {
    await subscribeFeed(sourceId, {
      externalId: feed.externalId,
      name: feed.name,
      kind: feed.kind,
    });
    await refreshFeeds();
  };

  const handleRunDigest = async (body: {
    periodStartMs?: number;
    periodEndMs?: number;
  }) => {
    await runDigest(body);
    await refreshDigests();
  };

  const handleSelectDigest = async (id: string): Promise<DigestView> => {
    return await getDigest(id);
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {
      // Even if logout fails, clear local state
    }
    props.onLogout();
  };

  const tabLabel = (tab: TabId, label: string) => (
    <button
      onClick={() => setActiveTab(tab)}
      class={activeTab() === tab ? "primary" : ""}
      style={{ "margin-right": "0.5rem" }}
    >
      {label}
    </button>
  );

  return (
    <div class="app-container">
      <header class="app-header">
        <h1>Morning Post</h1>
        <div class="user-info">
          <span>{props.user.email}</span>
          <button onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <nav style="margin-bottom: 1.5rem;">
        {tabLabel("digests", "Digests")}
        {tabLabel("sources", "Sources")}
        {tabLabel("feeds", "Feeds")}
      </nav>

      <Show when={activeTab() === "digests"}>
        <DigestRunnerCard
          onRun={handleRunDigest}
          onAuthError={props.onAuthError}
        />
        <div style="margin-top: 1rem;">
          <DigestsPanel
            digests={digests()}
            onSelectDigest={handleSelectDigest}
            onAuthError={props.onAuthError}
          />
        </div>
      </Show>

      <Show when={activeTab() === "sources"}>
        <SourcesPanel
          sources={sources()}
          onToggleSource={handleToggleSource}
          onDiscoverFeeds={handleDiscoverFeeds}
          onAuthError={props.onAuthError}
        />
      </Show>

      <Show when={activeTab() === "feeds"}>
        <FeedsPanel
          feeds={feeds()}
          availableFeeds={availableFeeds()}
          onToggleFeed={handleToggleFeed}
          onSubscribe={handleSubscribe}
          onAuthError={props.onAuthError}
        />
      </Show>
    </div>
  );
}
