/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import StatusBadge from "../app/StatusBadge";
import FormatTime from "../app/FormatTime";
import ProfilePanel from "../app/ProfilePanel";
import SourcesPanel from "../app/SourcesPanel";
import FeedsPanel from "../app/FeedsPanel";

describe("StatusBadge", () => {
  it("renders complete status", () => {
    const { container } = render(() => <StatusBadge status="complete" />);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("complete");
    expect(span?.className).toContain("badge-success");
  });

  it("renders failed status", () => {
    const { container } = render(() => <StatusBadge status="failed" />);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("failed");
    expect(span?.className).toContain("badge-failed");
  });

  it("renders pending status", () => {
    const { container } = render(() => <StatusBadge status="pending" />);
    const span = container.querySelector("span");
    expect(span?.textContent).toBe("pending");
    expect(span?.className).toContain("badge-pending");
  });
});

describe("FormatTime", () => {
  it("renders a time element with dateTime attribute", () => {
    const ms = 1700000000000;
    const { container } = render(() => <FormatTime ms={ms} />);
    const time = container.querySelector("time");
    expect(time).not.toBeNull();
    expect(time?.getAttribute("dateTime")).toBe(new Date(ms).toISOString());
  });
});

describe("ProfilePanel", () => {
  it("does not render a model selector", () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "Summarize plainly.",
      summaryPrompt: "",
      defaultLanguage: null,
      defaultRelevanceFilterMode: "personalized" as const,
      storyDetailLevel: "balanced" as const,
      relevanceThreshold: 60,
      maximumStoriesPerDigest: null,
      interestProfileVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const { container } = render(() => (
      <ProfilePanel
        user={user}
        interests={[]}
        interestsLoading={false}
        interestMutationId={null}
        interestsError={null}
        onCreateInterest={() => Promise.resolve()}
        onUpdateInterest={() => Promise.resolve()}
        onDeleteInterest={() => Promise.resolve()}
        onSave={() => Promise.resolve(user)}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));
    expect(container.querySelector("#profile-model")).toBeNull();
    expect(container.querySelector("#profile-name")).not.toBeNull();
    expect(container.querySelector("#profile-language")).not.toBeNull();
    expect(container.querySelector("#profile-prompt")).not.toBeNull();
    expect(container.querySelector("#profile-summary-prompt")).not.toBeNull();
  });

  it("renders balanced story detail, explains outcomes, and saves each detail level", async () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "Summarize plainly.",
      summaryPrompt: "",
      defaultLanguage: null,
      defaultRelevanceFilterMode: "personalized" as const,
      storyDetailLevel: "balanced" as const,
      relevanceThreshold: 60,
      maximumStoriesPerDigest: null,
      interestProfileVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const onSave = vi.fn(() => Promise.resolve(user));
    render(() => (
      <ProfilePanel
        user={user}
        interests={[]}
        interestsLoading={false}
        interestMutationId={null}
        interestsError={null}
        onCreateInterest={() => Promise.resolve()}
        onUpdateInterest={() => Promise.resolve()}
        onDeleteInterest={() => Promise.resolve()}
        onSave={onSave}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));

    const detail = screen.getByRole("combobox", { name: "Default story detail" });
    expect(detail).toHaveValue("balanced");
    expect(
      screen.getByText("A clear explanation of the key points and why they matter."),
    ).toBeVisible();

    await fireEvent.change(detail, { target: { value: "headlines" } });
    expect(
      screen.getByText("A quick scan with the essential point and context."),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      storyDetailLevel: "headlines",
    }));

    await fireEvent.change(detail, { target: { value: "thorough" } });
    expect(
      screen.getByText("More context, nuance, and connections between sources."),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      storyDetailLevel: "thorough",
    }));
  });

  it("renders the default story cap and preserves null when saved blank", async () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "Summarize plainly.",
      summaryPrompt: "",
      defaultLanguage: null,
      defaultRelevanceFilterMode: "personalized" as const,
      storyDetailLevel: "balanced" as const,
      relevanceThreshold: 60,
      maximumStoriesPerDigest: null,
      interestProfileVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const onSave = vi.fn(() => Promise.resolve(user));
    render(() => (
      <ProfilePanel
        user={user}
        interests={[]}
        interestsLoading={false}
        interestMutationId={null}
        interestsError={null}
        onCreateInterest={() => Promise.resolve()}
        onUpdateInterest={() => Promise.resolve()}
        onDeleteInterest={() => Promise.resolve()}
        onSave={onSave}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));

    const maximum = screen.getByLabelText(
      "Maximum stories per digest (Default: 12)",
    );
    expect(maximum).toHaveValue(null);
    expect(maximum).toHaveAttribute("placeholder", "Default (12)");

    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: null,
    }));
  });

  it("maps accessible story cap presets and custom values to the existing field", async () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "Summarize plainly.",
      summaryPrompt: "",
      defaultLanguage: null,
      defaultRelevanceFilterMode: "personalized" as const,
      storyDetailLevel: "balanced" as const,
      relevanceThreshold: 60,
      maximumStoriesPerDigest: null,
      interestProfileVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const onSave = vi.fn(() => Promise.resolve(user));
    render(() => (
      <ProfilePanel
        user={user}
        interests={[]}
        interestsLoading={false}
        interestMutationId={null}
        interestsError={null}
        onCreateInterest={() => Promise.resolve()}
        onUpdateInterest={() => Promise.resolve()}
        onDeleteInterest={() => Promise.resolve()}
        onSave={onSave}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));

    const preset = screen.getByRole("combobox", { name: "Digest size preset" });
    const maximum = screen.getByLabelText(
      "Maximum stories per digest (Default: 12)",
    );
    expect(preset).toHaveValue("standard");

    await fireEvent.change(preset, { target: { value: "concise" } });
    expect(maximum).toHaveValue(8);
    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: 8,
    }));

    await fireEvent.change(preset, { target: { value: "comprehensive" } });
    expect(maximum).toHaveValue(20);
    await fireEvent.change(preset, { target: { value: "custom" } });
    await fireEvent.input(maximum, { target: { value: "7" } });
    expect(maximum).toHaveValue(7);
    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: 7,
    }));

    await fireEvent.change(preset, { target: { value: "standard" } });
    expect(maximum).toHaveValue(null);
    await fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: null,
    }));
  });

  it("labels inferred rules and supports adding and removing a mute", async () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "Summarize plainly.",
      summaryPrompt: "",
      defaultLanguage: null,
      defaultRelevanceFilterMode: "personalized" as const,
      storyDetailLevel: "balanced" as const,
      relevanceThreshold: 60,
      maximumStoriesPerDigest: null,
      interestProfileVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const onCreateInterest = vi.fn(() => Promise.resolve());
    const onDeleteInterest = vi.fn(() => Promise.resolve());
    render(() => (
      <ProfilePanel
        user={user}
        interests={[{
          id: "rule-1",
          label: "Machine learning",
          kind: "topic",
          disposition: "mute",
          origin: "inferred",
          state: "active",
          strength: 60,
          expiresAt: null,
          createdAt: 0,
          updatedAt: 0,
        }]}
        interestsLoading={false}
        interestMutationId={null}
        interestsError={null}
        onCreateInterest={onCreateInterest}
        onUpdateInterest={() => Promise.resolve()}
        onDeleteInterest={onDeleteInterest}
        onSave={() => Promise.resolve(user)}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));
    expect(screen.getByRole("heading", { name: "Muted" })).toBeVisible();
    expect(screen.getByText("Inferred")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(onDeleteInterest).toHaveBeenCalledWith("rule-1");
    const labelInput = screen.getByLabelText("Topic, entity, phrase, or story type");
    await fireEvent.input(labelInput, { target: { value: "Cryptography" } });
    const addDisposition = document.querySelector("#interest-disposition")!;
    await fireEvent.change(addDisposition, { target: { value: "mute" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(onCreateInterest).toHaveBeenCalledWith({
      label: "Cryptography",
      kind: "topic",
      disposition: "mute",
      expiresAt: null,
    });
    expect(screen.getByRole("button", { name: "Unmute" })).toBeVisible();
  });
});

describe("SourcesPanel", () => {
  const source = {
    id: "source-1",
    userId: "user-1",
    connectorId: "Substack",
    position: null,
    enabled: true,
    showPaidPostTitles: false,
    connected: true,
    relevanceFilterMode: "inherit",
    createdAt: 0,
    updatedAt: 0,
  } as const;
  it("updates the source relevance policy", async () => {
    const onUpdateSource = vi.fn(() => Promise.resolve());
    render(() => (
      <SourcesPanel
        sources={[source]}
        feeds={[]}
        availableFeeds={{}}
        sourceFeeds={{}}
        onToggleSource={() => Promise.resolve()}
        onUpdateSourcePosition={() => Promise.resolve()}
        onUpdateSource={onUpdateSource}
        onDisconnectSource={() =>
          Promise.resolve({
            source,
            revokeTelegramSession: false,
            message: "Disconnected",
          })}
        onDiscoverFeeds={() => Promise.resolve([])}
        onLoadSourceFeeds={() => Promise.resolve([])}
        onSubscribe={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    expect(screen.queryByLabelText("Summary detail for Substack")).toBeNull();
    await fireEvent.change(
      screen.getByLabelText("Relevance filtering for Substack"),
      { target: { value: "include_all" } },
    );
    expect(onUpdateSource).toHaveBeenCalledWith("source-1", {
      relevanceFilterMode: "include_all",
    });
  });

  it("hides Discover feeds for Substack but keeps it for Telegram", () => {
    const props = {
      sources: [source],
      feeds: [],
      availableFeeds: {},
      sourceFeeds: {},
      onToggleSource: () => Promise.resolve(),
      onUpdateSourcePosition: () => Promise.resolve(),
      onDisconnectSource: () =>
        Promise.resolve({
          source,
          revokeTelegramSession: false,
          message: "Disconnected",
        }),
      onDiscoverFeeds: () => Promise.resolve([]),
      onLoadSourceFeeds: () => Promise.resolve([]),
      onSubscribe: () => Promise.resolve(),
      onAuthError: () => {},
    };
    const substack = render(() => <SourcesPanel {...props} />);
    expect(substack.container.textContent).not.toContain("Discover feeds");
    substack.unmount();

    const telegram = render(() => (
      <SourcesPanel
        {...props}
        sources={[{ ...source, connectorId: "Telegram" }]}
      />
    ));
    expect(telegram.container.textContent).toContain("Discover feeds");
  });
});

describe("FeedsPanel", () => {
  it("updates the feed relevance policy", async () => {
    const onUpdateFeed = vi.fn(() => Promise.resolve());
    const feed = {
      id: "feed-1",
      sourceId: "source-1",
      externalId: "feed-external",
      name: "Morning feed",
      kind: "news" as const,
      customPrompt: null,
      position: null,
      enabled: true,
      summarizationMode: "basic" as const,
      relevanceFilterMode: "inherit" as const,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: 0,
      updatedAt: 0,
    };
    render(() => (
      <FeedsPanel
        feeds={[feed]}
        onLoadFeed={() => Promise.resolve(feed)}
        onToggleFeed={() => Promise.resolve()}
        onUpdateFeed={onUpdateFeed}
        onUnsubscribeFeed={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));
    await fireEvent.change(
      screen.getByLabelText("Relevance filtering for Morning feed"),
      { target: { value: "personalized" } },
    );
    expect(onUpdateFeed).toHaveBeenCalledWith("feed-1", {
      relevanceFilterMode: "personalized",
    });
  });

  it("updates story detail independently for each feed", async () => {
    const onUpdateFeed = vi.fn(() => Promise.resolve());
    const firstFeed = {
      id: "telegram-feed-1",
      sourceId: "telegram-source",
      externalId: "channel-1",
      name: "Morning channel",
      kind: "discussion" as const,
      customPrompt: null,
      position: null,
      enabled: true,
      summarizationMode: "basic" as const,
      relevanceFilterMode: "inherit" as const,
      deletedAt: null,
      lastFetchedPeriodEndMs: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const secondFeed = {
      ...firstFeed,
      id: "telegram-feed-2",
      externalId: "channel-2",
      name: "Evening channel",
      summarizationMode: "thorough" as const,
    };
    render(() => (
      <FeedsPanel
        feeds={[firstFeed, secondFeed]}
        onLoadFeed={() => Promise.resolve(firstFeed)}
        onToggleFeed={() => Promise.resolve()}
        onUpdateFeed={onUpdateFeed}
        onUnsubscribeFeed={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    const firstSelector = screen.getByLabelText("Story detail for Morning channel");
    const secondSelector = screen.getByLabelText("Story detail for Evening channel");
    expect(firstSelector).toHaveValue("basic");
    expect(secondSelector).toHaveValue("thorough");
    expect(screen.getByText(
      "Standard follows your profile story-detail setting. Change the profile level in the Profile tab.",
    )).toBeVisible();
    expect(screen.getByText(
      "Thorough overrides your profile story-detail setting for this feed, adding more context and nuance.",
    )).toBeVisible();

    await fireEvent.change(firstSelector, { target: { value: "thorough" } });
    await fireEvent.change(secondSelector, { target: { value: "basic" } });

    expect(onUpdateFeed).toHaveBeenNthCalledWith(1, "telegram-feed-1", {
      summarizationMode: "thorough",
    });
    expect(onUpdateFeed).toHaveBeenNthCalledWith(2, "telegram-feed-2", {
      summarizationMode: "basic",
    });
    expect(firstSelector).toHaveValue("thorough");
    expect(secondSelector).toHaveValue("basic");
  });

  it("rolls story detail back after a failed update", async () => {
    const onUpdateFeed = vi.fn(() =>
      Promise.reject(new Error("Story detail could not be saved")),
    );
    render(() => (
      <FeedsPanel
        feeds={[{
          id: "feed-1",
          sourceId: "telegram-source",
          externalId: "channel-1",
          name: "Morning channel",
          kind: "discussion",
          customPrompt: null,
          position: null,
          enabled: true,
          summarizationMode: "basic",
          relevanceFilterMode: "inherit",
          deletedAt: null,
          lastFetchedPeriodEndMs: null,
          createdAt: 0,
          updatedAt: 0,
        }]}
        onLoadFeed={() => Promise.reject(new Error("not used"))}
        onToggleFeed={() => Promise.resolve()}
        onUpdateFeed={onUpdateFeed}
        onUnsubscribeFeed={() => Promise.resolve()}
        onAuthError={() => {}}
      />
    ));

    const selector = screen.getByLabelText("Story detail for Morning channel");
    await fireEvent.change(selector, { target: { value: "thorough" } });
    await waitFor(() => expect(selector).toHaveValue("basic"));
    expect(screen.getByText("Story detail could not be saved")).toBeVisible();
    expect(selector).toBeEnabled();
  });
});
