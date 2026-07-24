/** @jsxImportSource solid-js */
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type {
  DigestView,
  StoryFeedbackInput,
} from "../api/types";
import DigestsPanel from "./DigestsPanel";

const storyView: DigestView = {
  digest: {
    id: "digest-1",
    userId: "user-1",
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_086_400_000,
    status: "complete",
    contentMode: "stories",
    createdAt: 1_700_086_400_000,
    updatedAt: 1_700_086_400_000,
  },
  stories: [{
    id: "digest-story-1",
    digestId: "digest-1",
    storyId: "story-1",
    storyVersion: 4,
    profileVersion: 7,
    title: "A consequential policy changed",
    topics: ["Artificial intelligence"],
    entities: ["Example Corp"],
    points: [{
      text: "The policy now applies across the industry.",
      sourceUrl: "https://points.example/policy",
    }],
    sources: [
      {
        itemId: "item-1",
        connectorId: "Substack",
        sourceId: "source-1",
        feedId: "feed-1",
        feedName: "Policy Dispatch",
        title: "The complete policy report",
        url: "https://dispatch.example/report",
        publishedAt: 1_700_000_000_000,
      },
      {
        itemId: "item-2",
        connectorId: "RSS",
        sourceId: "source-2",
        feedId: "feed-2",
        feedName: "Industry Wire",
        title: null,
        url: "https://wire.example/update",
        publishedAt: 1_700_000_100_000,
      },
      {
        itemId: "item-3",
        connectorId: "Telegram",
        sourceId: "source-3",
        feedId: "feed-3",
        feedName: "Analyst Channel",
        title: "Analyst context",
        url: null,
        publishedAt: 1_700_000_200_000,
      },
      {
        itemId: "item-4",
        connectorId: "Substack",
        sourceId: "source-1",
        feedId: "feed-1",
        feedName: "Policy Dispatch",
        title: "A follow-up policy report",
        url: "https://dispatch.example/follow-up",
        publishedAt: 1_700_000_300_000,
      },
    ],
    relevanceScore: 87,
    matchedInterestRuleIds: ["rule-1", "rule-2"],
    generatedAt: 1_700_086_400_000,
  }],
  sections: [],
  groups: [],
  paidPosts: [],
  failureReason: null,
};

const legacyView: DigestView = {
  digest: {
    id: "legacy-digest-1",
    userId: "user-1",
    periodStartMs: 1_699_000_000_000,
    periodEndMs: 1_699_086_400_000,
    status: "complete",
    createdAt: 1_699_086_400_000,
    updatedAt: 1_699_086_400_000,
  },
  sections: [{
    sourceId: "legacy-source",
    connectorId: "RSS",
    feedId: "legacy-feed",
    feedName: "Historical Feed",
    feedRemoved: false,
    content: {
      kind: "aggregate",
      points: [{ text: "Historical summary point", sourceUrl: null }],
    },
  }],
  groups: [{
    sourceId: "legacy-source",
    connectorId: "RSS",
    sections: [{
      sourceId: "legacy-source",
      connectorId: "RSS",
      feedId: "legacy-feed",
      feedName: "Historical Feed",
      feedRemoved: false,
      content: {
        kind: "aggregate",
        points: [{ text: "Historical summary point", sourceUrl: null }],
      },
    }],
  }],
  paidPosts: [],
  failureReason: null,
};

function renderDigest(
  view: DigestView,
  options: {
    onSubmitFeedback?: (
      storyId: string,
      input: StoryFeedbackInput,
    ) => Promise<unknown>;
    onFeedbackSuccess?: () => void | Promise<void>;
  } = {},
) {
  return render(() => (
    <DigestsPanel
      digests={[view.digest]}
      onSelectDigest={() => Promise.resolve(view)}
      onDeleteDigest={() => Promise.resolve()}
      onAuthError={() => {}}
      onSubmitFeedback={options.onSubmitFeedback}
      onFeedbackSuccess={options.onFeedbackSuccess}
    />
  ));
}

async function openDigest() {
  await fireEvent.click(screen.getByRole("button", { name: /#1/ }));
  await waitFor(() =>
    expect(screen.getAllByRole("heading", {
      name: /A consequential policy changed|Historical Feed/,
    })[0]).toBeVisible()
  );
}

async function openStoryDetails() {
  const disclosure = screen.getAllByText("Story details and tuning")[0];
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
  await fireEvent.click(disclosure);
  expect(disclosure.closest("details")).toHaveAttribute("open");
}

describe("DigestsPanel story rendering", () => {
  it("groups stories under connector and feed headings with details collapsed", async () => {
    renderDigest(storyView, { onSubmitFeedback: () => Promise.resolve() });
    await openDigest();

    expect(screen.getByRole("heading", { level: 4, name: "Substack" }))
      .toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "RSS" }))
      .toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Telegram" }))
      .toBeVisible();
    expect(screen.getAllByRole("heading", { level: 5, name: "Policy Dispatch" }))
      .toHaveLength(1);
    expect(screen.getByRole("heading", { level: 5, name: "Industry Wire" }))
      .toBeVisible();
    expect(screen.getByRole("heading", { level: 5, name: "Analyst Channel" }))
      .toBeVisible();

    expect(screen.getAllByRole("heading", {
      level: 6,
      name: "A consequential policy changed",
    })).toHaveLength(3);
    expect(screen.getAllByText("The policy now applies across the industry."))
      .toHaveLength(3);
    const renderedIds = Array.from(document.querySelectorAll("[id]"), (node) =>
      node.id
    );
    expect(new Set(renderedIds).size).toBe(renderedIds.length);
    expect(screen.getAllByRole("link", { name: "source" })).toHaveLength(3);
    expect(screen.getAllByText("Story details and tuning")).toHaveLength(3);
    expect(screen.getAllByText("87% relevance").every((node) =>
      !node.closest("details")?.hasAttribute("open")
    )).toBe(true);

    await openStoryDetails();

    const firstDetails = screen.getAllByText("Story details and tuning")[0]
      .closest("details");
    expect(firstDetails).not.toBeNull();
    const scopedDetails = within(firstDetails!);
    expect(scopedDetails.getByText("2 sources")).toBeVisible();
    expect(scopedDetails.getByText("The complete policy report")).toBeVisible();
    expect(scopedDetails.getByText("A follow-up policy report")).toBeVisible();
    expect(scopedDetails.queryByText("Industry Wire")).toBeNull();
    expect(scopedDetails.queryByText("Analyst Channel")).toBeNull();
    expect(screen.getAllByText("87% relevance")[0]).toBeVisible();
    expect(screen.getAllByRole("heading", { name: "Tune this story" })[0])
      .toBeVisible();
  });

  it("keeps historical group rendering when contentMode and stories are absent", async () => {
    renderDigest(legacyView);
    await openDigest();

    expect(screen.getByRole("heading", { name: "Historical Feed" })).toBeVisible();
    expect(screen.getByText("Historical summary point")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Tune this story" })).toBeNull();
  });
});

describe("DigestsPanel story feedback", () => {
  it("sends all story action payloads without a target", async () => {
    const onSubmitFeedback = vi.fn(() => Promise.resolve());
    renderDigest(storyView, { onSubmitFeedback });
    await openDigest();
    await openStoryDetails();

    for (const label of ["Relevant", "Not for me", "Already knew", "Too repetitive"]) {
      await fireEvent.click(screen.getAllByRole("button", {
        name: `${label}: A consequential policy changed`,
      })[0]);
    }

    await waitFor(() => expect(onSubmitFeedback).toHaveBeenCalledTimes(4));
    expect(onSubmitFeedback.mock.calls).toEqual([
      ["story-1", { digestStoryId: "digest-story-1", action: "relevant" }],
      ["story-1", { digestStoryId: "digest-story-1", action: "not_relevant" }],
      ["story-1", { digestStoryId: "digest-story-1", action: "already_known" }],
      ["story-1", { digestStoryId: "digest-story-1", action: "too_repetitive" }],
    ]);
  });

  it("sends explicit topic and entity targets for every target action", async () => {
    const onSubmitFeedback = vi.fn(() => Promise.resolve());
    renderDigest(storyView, { onSubmitFeedback });
    await openDigest();
    await openStoryDetails();

    await fireEvent.click(screen.getAllByRole("button", {
      name: "Follow topic Artificial intelligence",
    })[0]);
    await fireEvent.click(screen.getAllByRole("button", {
      name: "Show less entity Example Corp",
    })[0]);
    await fireEvent.click(screen.getAllByRole("button", {
      name: "Mute topic Artificial intelligence",
    })[0]);

    await waitFor(() => expect(onSubmitFeedback).toHaveBeenCalledTimes(3));
    expect(onSubmitFeedback.mock.calls).toEqual([
      ["story-1", {
        digestStoryId: "digest-story-1",
        action: "follow_topic",
        target: { kind: "topic", label: "Artificial intelligence" },
      }],
      ["story-1", {
        digestStoryId: "digest-story-1",
        action: "show_less_topic",
        target: { kind: "entity", label: "Example Corp" },
      }],
      ["story-1", {
        digestStoryId: "digest-story-1",
        action: "mute_topic",
        target: { kind: "topic", label: "Artificial intelligence" },
      }],
    ]);
  });

  it("disables only the submitted control, blocks duplicates, and refreshes after success", async () => {
    let resolveRequest!: () => void;
    const onSubmitFeedback = vi.fn(() =>
      new Promise<void>((resolve) => {
        resolveRequest = resolve;
      })
    );
    const onFeedbackSuccess = vi.fn(() => Promise.resolve());
    renderDigest(storyView, { onSubmitFeedback, onFeedbackSuccess });
    await openDigest();
    await openStoryDetails();

    const relevant = screen.getAllByRole("button", {
      name: "Relevant: A consequential policy changed",
    })[0];
    const notForMe = screen.getAllByRole("button", {
      name: "Not for me: A consequential policy changed",
    })[0];
    await fireEvent.click(relevant);
    await fireEvent.click(relevant);

    expect(relevant).toBeDisabled();
    expect(relevant).toHaveAttribute("aria-busy", "true");
    expect(notForMe).toBeEnabled();
    expect(onSubmitFeedback).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Saving feedback…")[0]).toHaveAttribute("role", "status");

    resolveRequest();
    await waitFor(() =>
      expect(screen.getAllByText("Feedback saved.")[0]).toBeVisible()
    );
    expect(relevant).toBeEnabled();
    expect(onFeedbackSuccess).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed request without claiming or retaining success", async () => {
    const onSubmitFeedback = vi.fn(() =>
      Promise.reject(new Error("Feedback service unavailable"))
    );
    renderDigest(storyView, { onSubmitFeedback });
    await openDigest();
    await openStoryDetails();

    const notForMe = screen.getAllByRole("button", {
      name: "Not for me: A consequential policy changed",
    })[0];
    await fireEvent.click(notForMe);

    await waitFor(() =>
      expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
        "Feedback service unavailable",
      )
    );
    expect(notForMe).toBeEnabled();
    expect(screen.queryByText("Feedback saved.")).toBeNull();
  });

  it("keeps concurrent feedback outcomes attached to their actions", async () => {
    let resolveRelevant!: () => void;
    let rejectNotRelevant!: (error: Error) => void;
    const onSubmitFeedback = vi.fn((
      _storyId: string,
      input: StoryFeedbackInput,
    ) =>
      new Promise<void>((resolve, reject) => {
        if (input.action === "relevant") resolveRelevant = resolve;
        else rejectNotRelevant = reject;
      })
    );
    renderDigest(storyView, { onSubmitFeedback });
    await openDigest();
    await openStoryDetails();

    await fireEvent.click(screen.getAllByRole("button", {
      name: "Relevant: A consequential policy changed",
    })[0]);
    await fireEvent.click(screen.getAllByRole("button", {
      name: "Not for me: A consequential policy changed",
    })[0]);
    resolveRelevant();
    rejectNotRelevant(new Error("Not-for-me feedback failed"));

    await waitFor(() =>
      expect(screen.getAllByText("Feedback saved.")[0]).toBeVisible()
    );
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
      "Not-for-me feedback failed",
    );
  });
});
