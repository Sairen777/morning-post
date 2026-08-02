/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
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
  it("does not render a model selector", async () => {
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
    expect(screen.getByRole("tab", { name: /^Preferences/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /^Interests/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /^Activity/ })).toBeVisible();

    await fireEvent.click(screen.getByRole("tab", { name: /^Activity/ }));
    expect(screen.getByText(
      "Run a digest to start building your activity history.",
    )).toBeVisible();

    await fireEvent.click(screen.getByRole("tab", { name: /^Preferences/ }));
    const preferences = within(
      screen.getByRole("tabpanel", { name: /^Preferences/ }),
    );
    expect(preferences.getByLabelText("Your name")).toBeInTheDocument();
    expect(preferences.getByLabelText("Digest language")).toBeInTheDocument();

    await fireEvent.click(preferences.getByText("Advanced instructions"));
    expect(preferences.getByLabelText("Interest instructions"))
      .toBeInTheDocument();
    expect(preferences.getByLabelText("Summary writing instructions"))
      .toBeInTheDocument();
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

    await fireEvent.click(screen.getByRole("tab", { name: /^Preferences/ }));
    const preferences = within(
      screen.getByRole("tabpanel", { name: /^Preferences/ }),
    );
    const detail = preferences.getByRole("combobox", {
      name: "How much context should stories include?",
    });
    expect(detail).toHaveValue("balanced");
    expect(
      preferences.getByText("A clear explanation of the key points and why they matter."),
    ).toBeVisible();

    await fireEvent.change(detail, { target: { value: "headlines" } });
    expect(
      preferences.getByText("A quick scan with the essential point and context."),
    ).toBeVisible();
    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      storyDetailLevel: "headlines",
    }));

    await fireEvent.change(detail, { target: { value: "thorough" } });
    expect(
      preferences.getByText("More context, nuance, and connections between sources."),
    ).toBeVisible();
    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
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

    await fireEvent.click(screen.getByRole("tab", { name: /^Preferences/ }));
    const preferences = within(
      screen.getByRole("tabpanel", { name: /^Preferences/ }),
    );
    const maximum = preferences.getByLabelText("Maximum stories per digest");
    expect(maximum).toHaveValue(null);
    expect(maximum).toHaveAttribute("placeholder", "Default (12)");

    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
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

    await fireEvent.click(screen.getByRole("tab", { name: /^Preferences/ }));
    const preferences = within(
      screen.getByRole("tabpanel", { name: /^Preferences/ }),
    );
    const preset = preferences.getByRole("combobox", { name: "Digest size" });
    const maximum = preferences.getByLabelText("Maximum stories per digest");
    expect(preset).toHaveValue("standard");

    await fireEvent.change(preset, { target: { value: "concise" } });
    expect(maximum).toHaveValue(8);
    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: 8,
    }));

    await fireEvent.change(preset, { target: { value: "comprehensive" } });
    expect(maximum).toHaveValue(20);
    await fireEvent.change(preset, { target: { value: "custom" } });
    await fireEvent.input(maximum, { target: { value: "7" } });
    expect(maximum).toHaveValue(7);
    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      maximumStoriesPerDigest: 7,
    }));

    await fireEvent.change(preset, { target: { value: "standard" } });
    expect(maximum).toHaveValue(null);
    await fireEvent.click(preferences.getByRole("button", { name: "Save preferences" }));
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

    await fireEvent.click(screen.getByRole("tab", { name: /^Interests/ }));
    const interests = within(
      screen.getByRole("tabpanel", { name: /^Interests/ }),
    );
    const muteGroup = within(interests.getByRole("region", { name: "Mute" }));
    expect(muteGroup.getByRole("heading", { name: "Mute" })).toBeVisible();
    expect(muteGroup.getByText(/Inferred from reading/)).toBeVisible();

    const ruleCard = within(
      muteGroup.getByRole("heading", { name: "Machine learning" })
        .closest("article")!,
    );
    await fireEvent.click(ruleCard.getByText("Edit rule"));
    await fireEvent.click(
      ruleCard.getByRole("button", { name: "Delete rule Machine learning" }),
    );
    expect(onDeleteInterest).toHaveBeenCalledWith("rule-1");

    const addSection = within(
      interests.getByRole("region", { name: "Add an interest rule" }),
    );
    const labelInput = addSection.getByLabelText("What should Morning Post notice?");
    await fireEvent.input(labelInput, { target: { value: "Cryptography" } });
    await fireEvent.change(
      addSection.getByLabelText("How should it affect your digest?"),
      { target: { value: "mute" } },
    );
    await fireEvent.click(addSection.getByRole("button", { name: "Add rule" }));
    expect(onCreateInterest).toHaveBeenCalledWith({
      label: "Cryptography",
      kind: "topic",
      disposition: "mute",
      expiresAt: null,
    });
    expect(labelInput).toHaveValue("");
  });
  it("supports roving profile tabs with keyboard navigation", async () => {
    const user = {
      id: "user-1",
      name: "Ada",
      systemPrompt: "",
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
        onSave={() => Promise.resolve(user)}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));

    const preferences = screen.getByRole("tab", { name: /^Preferences/ });
    const interests = screen.getByRole("tab", { name: /^Interests/ });
    const activity = screen.getByRole("tab", { name: /^Activity/ });
    expect(preferences).toHaveAttribute("tabindex", "0");
    expect(interests).toHaveAttribute("tabindex", "-1");
    preferences.focus();

    await fireEvent.keyDown(preferences, { key: "ArrowRight" });
    expect(interests).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(interests);

    await fireEvent.keyDown(interests, { key: "End" });
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(activity);

    await fireEvent.keyDown(activity, { key: "Home" });
    expect(preferences).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(preferences);
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
    const sourceCard = within(
      screen.getByRole("heading", { name: "Substack" }).closest("article")!,
    );
    expect(sourceCard.queryByLabelText("Summary detail for Substack")).toBeNull();
    await fireEvent.click(
      sourceCard.getByText("Source settings and maintenance"),
    );
    await fireEvent.change(
      sourceCard.getByLabelText("Relevance filtering for Substack"),
      { target: { value: "include_all" } },
    );
    expect(onUpdateSource).toHaveBeenCalledWith("source-1", {
      relevanceFilterMode: "include_all",
    });
  });

  it("shows Manage publications guidance for Substack but keeps Discover feeds for Telegram", () => {
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
    const substackCard = within(
      screen.getByRole("heading", { name: "Substack" }).closest("article")!,
    );
    expect(substackCard.getByRole("heading", { name: "Manage publications" }))
      .toBeVisible();
    expect(substackCard.getByText(
      "Manage followed publications for this service in Connections.",
    )).toBeVisible();
    expect(substackCard.getByText(
      "Publication selection for this service is managed in Connections.",
    )).toBeVisible();
    expect(substackCard.queryByRole("button", { name: "Discover feeds" }))
      .toBeNull();
    substack.unmount();

    const telegram = render(() => (
      <SourcesPanel
        {...props}
        sources={[{ ...source, connectorId: "Telegram" }]}
      />
    ));
    const telegramCard = within(
      screen.getByRole("heading", { name: "Telegram" }).closest("article")!,
    );
    expect(telegramCard.getByRole("button", { name: "Discover feeds" }))
      .toBeVisible();
  });

  it("discovers and subscribes Lists and XChat groups for an X source", async () => {
    const xSource = { ...source, id: "source-x", connectorId: "X" };
    const availableFeeds = [
      {
        externalId: "x:list:123",
        name: "Engineering list",
        kind: "news" as const,
      },
      {
        externalId: "x:chat:conversation_1",
        name: "Project chat",
        kind: "discussion" as const,
      },
    ];
    const onDiscoverFeeds = vi.fn(() => Promise.resolve(availableFeeds));
    const onSubscribe = vi.fn(() => Promise.resolve());
    render(() => (
      <SourcesPanel
        sources={[xSource]}
        feeds={[]}
        availableFeeds={{ "source-x": availableFeeds }}
        sourceFeeds={{}}
        onToggleSource={() => Promise.resolve()}
        onUpdateSourcePosition={() => Promise.resolve()}
        onDisconnectSource={() =>
          Promise.resolve({
            source: xSource,
            revokeTelegramSession: false,
            message: "Disconnected",
          })}
        onDiscoverFeeds={onDiscoverFeeds}
        onLoadSourceFeeds={() => Promise.resolve([])}
        onSubscribe={onSubscribe}
        onAuthError={() => {}}
      />
    ));
    const xCard = within(
      screen.getByRole("heading", { name: "X" }).closest("article")!,
    );
    const discoverButton = xCard.getByRole("button", {
      name: "Discover Lists and XChat groups",
    });
    expect(
      xCard.getByRole("heading", { name: "Discover Lists and XChat groups" }),
    ).toBeVisible();
    expect(xCard.getByText("Lists and XChat groups you choose to monitor for timely updates."))
      .toBeVisible();

    await fireEvent.click(discoverButton);
    await waitFor(() =>
      expect(onDiscoverFeeds).toHaveBeenCalledWith("source-x")
    );

    expect(xCard.getByText("Engineering list")).toBeVisible();
    expect(xCard.getByText("Project chat")).toBeVisible();
    expect(xCard.getByText("News")).toBeVisible();
    expect(xCard.getByText("Discussion")).toBeVisible();

    await fireEvent.click(
      xCard.getByRole("button", { name: "Subscribe to Engineering list" }),
    );
    await fireEvent.click(
      xCard.getByRole("button", { name: "Subscribe to Project chat" }),
    );
    expect(onSubscribe).toHaveBeenCalledWith("source-x", availableFeeds[0]);
    expect(onSubscribe).toHaveBeenCalledWith("source-x", availableFeeds[1]);
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
    const feedCard = within(
      screen.getByRole("heading", { name: "Morning feed" }).closest("article")!,
    );
    await fireEvent.click(feedCard.getByText("Customize & advanced"));
    await fireEvent.change(
      feedCard.getByLabelText("Relevance policy for Morning feed"),
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

    const firstCard = within(
      screen.getByRole("heading", { name: "Morning channel" })
        .closest("article")!,
    );
    const secondCard = within(
      screen.getByRole("heading", { name: "Evening channel" })
        .closest("article")!,
    );
    await fireEvent.click(firstCard.getByText("Customize & advanced"));
    await fireEvent.click(secondCard.getByText("Customize & advanced"));

    const firstSelector = firstCard.getByLabelText("Summary depth for Morning channel");
    const secondSelector = secondCard.getByLabelText("Summary depth for Evening channel");
    expect(firstSelector).toHaveValue("basic");
    expect(secondSelector).toHaveValue("thorough");
    expect(firstCard.getByText(
      "Standard follows your profile story-detail setting.",
    )).toBeVisible();
    expect(secondCard.getByText(
      "Thorough adds more context and nuance.",
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

    const feedCard = within(
      screen.getByRole("heading", { name: "Morning channel" })
        .closest("article")!,
    );
    await fireEvent.click(feedCard.getByText("Customize & advanced"));
    const selector = feedCard.getByLabelText("Summary depth for Morning channel");
    await fireEvent.change(selector, { target: { value: "thorough" } });
    await waitFor(() => expect(selector).toHaveValue("basic"));
    expect(feedCard.getByText("Story detail could not be saved")).toBeVisible();
    expect(selector).toBeEnabled();
  });
});
