import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  ApiClientError,
  createInterest,
  deleteDigest,
  deleteInterest,
  disconnectSource,
  getDigest,
  getCurrentUser,
  getDigestRunDetail,
  getFeed,
  listAvailableFeeds,
  listDigestRuns,
  listDigests,
  listFeeds,
  listFeedsForSource,
  listInterests,
  listSources,
  logoutUser,
  runDigest,
  submitStoryFeedback,
  subscribeFeed,
  unsubscribeFeed,
  updateCurrentUser,
  updateFeed,
  updateInterest,
  updateSource,
} from "../api/client";
import type {
  AvailableFeed,
  DigestRunDetail,
  DigestView,
  DisconnectSourceResponse,
  InterestRuleDisposition,
  InterestRuleKind,
  PublicDigest,
  PublicDigestRun,
  PublicFeed,
  PublicInterestRule,
  PublicSource,
  PublicUser,
  RelevanceFilterOverride,
} from "../api/types";
import DigestRunnerCard from "./DigestRunnerCard";
import SourcesPanel from "./SourcesPanel";
import FeedsPanel from "./FeedsPanel";
import DigestsPanel from "./DigestsPanel";
import DigestRunsPanel from "./DigestRunsPanel";
import TelegramConnectPanel from "./TelegramConnectPanel";
import SubstackConnectPanel from "./SubstackConnectPanel";
import ProfilePanel from "./ProfilePanel";

interface DashboardProps {
  user: PublicUser;
  onLogout: () => void;
  onAuthError: () => void;
  onUserUpdate: (user: PublicUser) => void;
}

type TabId =
  | "digests"
  | "runs"
  | "connections"
  | "sources"
  | "feeds"
  | "profile";

export default function Dashboard(props: DashboardProps) {
  const [activeTab, setActiveTab] = createSignal<TabId>("digests");

  // Data signals
  const [sources, setSources] = createSignal<PublicSource[]>([]);
  const [feeds, setFeeds] = createSignal<PublicFeed[]>([]);
  const [digests, setDigests] = createSignal<PublicDigest[]>([]);
  const [digestRuns, setDigestRuns] = createSignal<PublicDigestRun[]>([]);
  const [availableFeeds, setAvailableFeeds] = createSignal<
    Record<string, AvailableFeed[]>
  >({});
  const [digestCursor, setDigestCursor] = createSignal<string | undefined>(
    undefined,
  );
  const [digestRunCursor, setDigestRunCursor] = createSignal<
    string | undefined
  >(undefined);
  const [loadingMoreDigests, setLoadingMoreDigests] = createSignal(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = createSignal(false);
  const [sourceFeeds, setSourceFeeds] = createSignal<
    Record<string, PublicFeed[]>
  >({});
  const [interests, setInterests] = createSignal<PublicInterestRule[]>([]);
  const [interestsLoading, setInterestsLoading] = createSignal(true);
  const [interestMutationId, setInterestMutationId] = createSignal<string | null>(
    null,
  );
  const [interestsError, setInterestsError] = createSignal<string | null>(null);
  const [isCheckingDigestRunStatus, setIsCheckingDigestRunStatus] =
    createSignal(
      true,
    );
  const [digestRunStatusError, setDigestRunStatusError] = createSignal<
    string | null
  >(null);
  let digestRunPollingTimer:
    | ReturnType<typeof globalThis.setInterval>
    | undefined;
  let digestRunRefreshInFlight = false;
  const digestRunStatusCheckError =
    "We couldn't confirm whether a digest is already running. Retry the status check before starting another digest.";
  let feedRefreshGeneration = 0;

  // Fetch helpers
  const refreshSources = async () => {
    try {
      setSources(await listSources());
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    }
  };

  const refreshFeeds = async () => {
    const requestGeneration = ++feedRefreshGeneration;
    try {
      const refreshedFeeds = await listFeeds();
      if (requestGeneration === feedRefreshGeneration) {
        setFeeds(refreshedFeeds);
      }
    } catch (err: unknown) {
      if (requestGeneration !== feedRefreshGeneration) return;
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    }
  };

  const refreshInterests = async () => {
    setInterestsLoading(true);
    try {
      setInterests(await listInterests());
      setInterestsError(null);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setInterestsError(err.message);
      } else {
        setInterestsError("We couldn't load your interests.");
      }
    } finally {
      setInterestsLoading(false);
    }
  };

  const refreshDigests = async () => {
    try {
      const page = await listDigests();
      setDigests(page.data);
      setDigestCursor(page.nextCursor);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    }
  };

  const refreshDigestRuns = async (): Promise<boolean> => {
    try {
      const page = await listDigestRuns();
      setDigestRuns(page.data);
      setDigestRunCursor(page.nextCursor);
      setDigestRunStatusError(null);
      return true;
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else {
        setDigestRunStatusError(digestRunStatusCheckError);
      }
      return false;
    }
  };

  const activeDigestRun = () =>
    digestRuns().find((run) => run.status === "running");

  const pollDigestRuns = async () => {
    if (digestRunRefreshInFlight) return;
    digestRunRefreshInFlight = true;
    const hadActiveDigestRun = activeDigestRun() !== undefined;
    try {
      const refreshed = await refreshDigestRuns();
      if (refreshed && hadActiveDigestRun && activeDigestRun() === undefined) {
        await refreshDigests();
      }
    } finally {
      digestRunRefreshInFlight = false;
    }
  };

  createEffect(() => {
    if (isCheckingDigestRunStatus() || activeDigestRun() === undefined) {
      if (digestRunPollingTimer !== undefined) {
        globalThis.clearInterval(digestRunPollingTimer);
        digestRunPollingTimer = undefined;
      }
      return;
    }
    if (digestRunPollingTimer === undefined) {
      digestRunPollingTimer = globalThis.setInterval(() => {
        void pollDigestRuns();
      }, 5_000);
    }
    onCleanup(() => {
      if (digestRunPollingTimer !== undefined) {
        globalThis.clearInterval(digestRunPollingTimer);
        digestRunPollingTimer = undefined;
      }
    });
  });

  const handleLoadMoreDigests = async () => {
    const cursor = digestCursor();
    if (!cursor || loadingMoreDigests()) return;
    setLoadingMoreDigests(true);
    try {
      const page = await listDigests({ cursor });
      setDigests((prev) => {
        const existingIds = new Set(prev.map((d) => d.id));
        const newItems = page.data.filter((d) => !existingIds.has(d.id));
        return [...prev, ...newItems];
      });
      setDigestCursor(page.nextCursor);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    } finally {
      setLoadingMoreDigests(false);
    }
  };

  const handleLoadMoreRuns = async () => {
    const cursor = digestRunCursor();
    if (!cursor || loadingMoreRuns()) return;
    setLoadingMoreRuns(true);
    try {
      const page = await listDigestRuns({ cursor });
      setDigestRuns((prev) => {
        const existingIds = new Set(prev.map((r) => r.id));
        const newItems = page.data.filter((r) => !existingIds.has(r.id));
        return [...prev, ...newItems];
      });
      setDigestRunCursor(page.nextCursor);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      }
    } finally {
      setLoadingMoreRuns(false);
    }
  };

  const refreshSourceFeedsIfLoaded = async (sourceId: string) => {
    const current = sourceFeeds();
    if (Object.prototype.hasOwnProperty.call(current, sourceId)) {
      try {
        const result = await listFeedsForSource(sourceId);
        setSourceFeeds((prev) => ({ ...prev, [sourceId]: result }));
      } catch (err: unknown) {
        if (err instanceof ApiClientError && err.status === 401) {
          props.onAuthError();
        }
      }
    }
  };
  onMount(() => {
    refreshSources();
    refreshFeeds();
    refreshDigests();
    refreshInterests();
    void (async () => {
      await refreshDigestRuns();
      setIsCheckingDigestRunStatus(false);
    })();
  });

  // Actions
  const handleToggleSource = async (id: string, enabled: boolean) => {
    try {
      await updateSource(id, { enabled });
    } finally {
      await refreshSources();
    }
  };

  const handleUpdateSourcePosition = async (
    id: string,
    position: number | null,
  ) => {
    await updateSource(id, { position });
    await refreshSources();
  };

  const handleDisconnectSource = async (
    id: string,
  ): Promise<DisconnectSourceResponse> => {
    const result = await disconnectSource(id);
    await refreshSources();
    await refreshFeeds();
    await refreshSourceFeedsIfLoaded(id);
    return result;
  };

  const handleUpdateSource = async (
    id: string,
    input: { relevanceFilterMode: RelevanceFilterOverride },
  ) => {
    await updateSource(id, input);
    await refreshSources();
  };

  const handleDiscoverFeeds = async (
    sourceId: string,
  ): Promise<AvailableFeed[]> => {
    const result = await listAvailableFeeds(sourceId);
    setAvailableFeeds((prev) => ({ ...prev, [sourceId]: result }));
    return result;
  };

  const handleLoadSourceFeeds = async (
    sourceId: string,
  ): Promise<PublicFeed[]> => {
    const result = await listFeedsForSource(sourceId);
    setSourceFeeds((prev) => ({ ...prev, [sourceId]: result }));
    return result;
  };

  const handleToggleFeed = async (id: string, enabled: boolean) => {
    await updateFeed(id, { enabled });
    await refreshFeeds();
  };

  const handleSubscribeFeed = async (
    sourceId: string,
    feed: AvailableFeed,
  ) => {
    await subscribeFeed(sourceId, {
      externalId: feed.externalId,
      name: feed.name,
      kind: feed.kind,
    });
    await refreshFeeds();
    await refreshSourceFeedsIfLoaded(sourceId);
  };

  const handleLoadFeed = async (id: string): Promise<PublicFeed> => {
    return await getFeed(id);
  };

  const handleUpdateFeed = async (
    id: string,
    input: {
      kind?: "news" | "discussion";
      customPrompt?: string | null;
      position?: number | null;
      enabled?: boolean;
      relevanceFilterMode?: RelevanceFilterOverride;
    },
  ) => {
    const updated = await updateFeed(id, input);
    await refreshFeeds();
    await refreshSourceFeedsIfLoaded(updated.sourceId);
  };

  const handleUnsubscribeFeed = async (id: string) => {
    const deleted = await unsubscribeFeed(id);
    await refreshFeeds();
    await refreshSourceFeedsIfLoaded(deleted.sourceId);
  };
  const handleCreateInterest = async (input: {
    label: string;
    kind: InterestRuleKind;
    disposition: InterestRuleDisposition;
    strength?: number;
    expiresAt?: number | null;
  }) => {
    setInterestMutationId("new");
    try {
      const created = await createInterest(input);
      setInterests((prev) => [...prev, created]);
      setInterestsError(null);
    } finally {
      setInterestMutationId(null);
    }
  };

  const handleUpdateInterest = async (
    id: string,
    input: Partial<{
      label: string;
      kind: InterestRuleKind;
      disposition: InterestRuleDisposition;
      strength: number;
      expiresAt: number | null;
    }>,
  ) => {
    setInterestMutationId(id);
    try {
      const updated = await updateInterest(id, input);
      setInterests((prev) => prev.map((rule) => rule.id === id ? updated : rule));
      setInterestsError(null);
    } finally {
      setInterestMutationId(null);
    }
  };

  const handleDeleteInterest = async (id: string) => {
    const previous = interests();
    setInterestMutationId(id);
    setInterests((prev) => prev.filter((rule) => rule.id !== id));
    try {
      await deleteInterest(id);
      setInterestsError(null);
    } catch (err: unknown) {
      setInterests(previous);
      throw err;
    } finally {
      setInterestMutationId(null);
    }
  };

  const handleRunDigest = async (body: {
    periodStartMs?: number;
    periodEndMs?: number;
  }) => {
    await runDigest(body);
    await refreshDigests();
    await refreshDigestRuns();
  };

  const handleSelectDigest = async (id: string): Promise<DigestView> => {
    return await getDigest(id);
  };

  const handleDeleteDigest = async (id: string): Promise<void> => {
    await deleteDigest(id);
    await refreshDigests();
    await refreshDigestRuns();
  };

  const refreshProfileAndPreferences = async () => {
    await Promise.all([
      refreshInterests(),
      getCurrentUser()
        .then((user) => props.onUserUpdate(user))
        .catch((err: unknown) => {
          if (err instanceof ApiClientError && err.status === 401) {
            props.onAuthError();
          }
        }),
    ]);
  };

  const handleSelectRun = async (id: string): Promise<DigestRunDetail> => {
    return await getDigestRunDetail(id);
  };

  const handleSaveProfile = async (input: {
    name?: string;
    systemPrompt?: string;
    summaryPrompt?: string;
    defaultLanguage?: string | null;
    defaultRelevanceFilterMode?: "personalized" | "include_all";
    relevanceThreshold?: number;
    maximumStoriesPerDigest?: number | null;
  }): Promise<PublicUser> => {
    const updated = await updateCurrentUser(input);
    props.onUserUpdate(updated);
    return updated;
  };

  const handleTelegramConnected = async () => {
    await refreshSources();
    await refreshFeeds();
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {
      // Even if logout fails, clear local state
    }
    props.onLogout();
  };

  const handleSubstackConnected = async () => {
    await refreshSources();
    await refreshFeeds();
  };

  const handleSubstackSourceUpdated = async () => {
    await refreshSources();
  };

  const handleSubstackPublicationAdded = async () => {
    const substackSourceId = sources().find((source) =>
      source.connectorId === "Substack"
    )?.id;
    await refreshSources();
    await refreshFeeds();
    if (substackSourceId) await refreshSourceFeedsIfLoaded(substackSourceId);
  };

  const tabLabel = (tab: TabId, label: string) => (
    <button
      type="button"
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
          <button type="button" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <nav style="margin-bottom: 1.5rem;">
        {tabLabel("digests", "Digests")}
        {tabLabel("runs", "Runs")}
        {tabLabel("connections", "Connections")}
        {tabLabel("sources", "Sources")}
        {tabLabel("feeds", "Feeds")}
        {tabLabel("profile", "Profile")}
      </nav>

      <Show when={activeTab() === "digests"}>
        <DigestRunnerCard
          onRun={handleRunDigest}
          onAuthError={props.onAuthError}
          activeRun={activeDigestRun()}
          isCheckingRunStatus={isCheckingDigestRunStatus()}
          runStatusError={digestRunStatusError()}
          onRefreshRunStatus={async () => {
            await refreshDigestRuns();
          }}
          onOpenRuns={() => setActiveTab("runs")}
        />
        <div style="margin-top: 1rem;">
          <DigestsPanel
            digests={digests()}
            onSelectDigest={handleSelectDigest}
            onDeleteDigest={handleDeleteDigest}
            onAuthError={props.onAuthError}
            onSubmitFeedback={submitStoryFeedback}
            onFeedbackSuccess={refreshProfileAndPreferences}
            nextCursor={digestCursor()}
            loadingMore={loadingMoreDigests()}
            onLoadMore={handleLoadMoreDigests}
          />
        </div>
      </Show>

      <Show when={activeTab() === "runs"}>
        <DigestRunsPanel
          runs={digestRuns()}
          onSelectRun={handleSelectRun}
          onRefresh={async () => {
            await refreshDigestRuns();
          }}
          onAuthError={props.onAuthError}
          nextCursor={digestRunCursor()}
          loadingMore={loadingMoreRuns()}
          onLoadMore={handleLoadMoreRuns}
        />
      </Show>

      <Show when={activeTab() === "connections"}>
        <TelegramConnectPanel
          sources={sources()}
          onConnected={handleTelegramConnected}
          onAuthError={props.onAuthError}
        />
        <SubstackConnectPanel
          sources={sources()}
          feeds={feeds()}
          onConnected={handleSubstackConnected}
          onPublicationAdded={handleSubstackPublicationAdded}
          onSourceUpdated={handleSubstackSourceUpdated}
          onAuthError={props.onAuthError}
        />
      </Show>

      <Show when={activeTab() === "sources"}>
        <SourcesPanel
          sources={sources()}
          feeds={feeds()}
          availableFeeds={availableFeeds()}
          sourceFeeds={sourceFeeds()}
          onToggleSource={handleToggleSource}
          onUpdateSourcePosition={handleUpdateSourcePosition}
          onUpdateSource={handleUpdateSource}
          onDisconnectSource={handleDisconnectSource}
          onDiscoverFeeds={handleDiscoverFeeds}
          onLoadSourceFeeds={handleLoadSourceFeeds}
          onSubscribe={handleSubscribeFeed}
          onAuthError={props.onAuthError}
        />
      </Show>

      <Show when={activeTab() === "feeds"}>
        <FeedsPanel
          feeds={feeds()}
          onLoadFeed={handleLoadFeed}
          onToggleFeed={handleToggleFeed}
          onUpdateFeed={handleUpdateFeed}
          onUnsubscribeFeed={handleUnsubscribeFeed}
          onAuthError={props.onAuthError}
        />
      </Show>

      <Show when={activeTab() === "profile"}>
        <ProfilePanel
          user={props.user}
          onSave={handleSaveProfile}
          interests={interests()}
          interestsLoading={interestsLoading()}
          interestMutationId={interestMutationId()}
          interestsError={interestsError()}
          onCreateInterest={handleCreateInterest}
          onUpdateInterest={handleUpdateInterest}
          onDeleteInterest={handleDeleteInterest}
          onSaved={props.onUserUpdate}
          onAuthError={props.onAuthError}
        />
      </Show>
    </div>
  );
}
