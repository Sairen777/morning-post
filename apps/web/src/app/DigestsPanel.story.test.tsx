/** @jsxImportSource solid-js */
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
    expect(screen.getByRole("heading", {
      name: /A consequential policy changed|Historical Feed/,
    })).toBeVisible()
  );
}

describe("DigestsPanel story rendering", () => {
  it("renders story details, provenance feed labels, and every source link", async () => {
    renderDigest(storyView, { onSubmitFeedback: () => Promise.resolve() });
    await openDigest();

    expect(screen.getByRole("heading", {
      name: "A consequential policy changed",
    })).toBeVisible();
    expect(screen.getByText("The policy now applies across the industry."))
      .toBeVisible();
    expect(screen.getByText("87% relevance")).toBeVisible();
    expect(screen.getAllByText("Artificial intelligence")).toHaveLength(2);
    expect(screen.getAllByText("Example Corp")).toHaveLength(2);
    expect(screen.getByText("Policy Dispatch")).toBeVisible();
    expect(screen.getByText("Industry Wire")).toBeVisible();
    expect(screen.getByText("Analyst Channel")).toBeVisible();
    expect(screen.getByText("Analyst context")).toBeVisible();

    expect(screen.getByRole("link", { name: "The complete policy report" }))
      .toHaveAttribute("href", "https://dispatch.example/report");
    expect(screen.getByRole("link", { name: "Industry Wire" }))
      .toHaveAttribute("href", "https://wire.example/update");
    expect(screen.getByRole("link", { name: "source" }))
      .toHaveAttribute("href", "https://points.example/policy");
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

    for (const label of ["Relevant", "Not for me", "Already knew", "Too repetitive"]) {
      await fireEvent.click(screen.getByRole("button", {
        name: `${label}: A consequential policy changed`,
      }));
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

    await fireEvent.click(screen.getByRole("button", {
      name: "Follow topic Artificial intelligence",
    }));
    await fireEvent.click(screen.getByRole("button", {
      name: "Show less entity Example Corp",
    }));
    await fireEvent.click(screen.getByRole("button", {
      name: "Mute topic Artificial intelligence",
    }));

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

    const relevant = screen.getByRole("button", {
      name: "Relevant: A consequential policy changed",
    });
    const notForMe = screen.getByRole("button", {
      name: "Not for me: A consequential policy changed",
    });
    await fireEvent.click(relevant);
    await fireEvent.click(relevant);

    expect(relevant).toBeDisabled();
    expect(relevant).toHaveAttribute("aria-busy", "true");
    expect(notForMe).toBeEnabled();
    expect(onSubmitFeedback).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saving feedback…")).toHaveAttribute("role", "status");

    resolveRequest();
    await waitFor(() => expect(screen.getByText("Feedback saved.")).toBeVisible());
    expect(relevant).toBeEnabled();
    expect(onFeedbackSuccess).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed request without claiming or retaining success", async () => {
    const onSubmitFeedback = vi.fn(() =>
      Promise.reject(new Error("Feedback service unavailable"))
    );
    renderDigest(storyView, { onSubmitFeedback });
    await openDigest();

    const notForMe = screen.getByRole("button", {
      name: "Not for me: A consequential policy changed",
    });
    await fireEvent.click(notForMe);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
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

    await fireEvent.click(screen.getByRole("button", {
      name: "Relevant: A consequential policy changed",
    }));
    await fireEvent.click(screen.getByRole("button", {
      name: "Not for me: A consequential policy changed",
    }));
    resolveRelevant();
    rejectNotRelevant(new Error("Not-for-me feedback failed"));

    await waitFor(() =>
      expect(screen.getByText("Feedback saved.")).toBeVisible()
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not-for-me feedback failed",
    );
  });
});
