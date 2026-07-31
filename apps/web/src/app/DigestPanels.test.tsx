/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import type {
  DigestRunDetail,
  DigestView,
  PublicDigest,
  PublicDigestRun,
} from "../api/types";
import DigestRunsPanel from "./DigestRunsPanel";
import DigestsPanel, { DigestViewContent } from "./DigestsPanel";

const sampleView: DigestView = {
  digest: {
    id: "d1",
    userId: "u1",
    periodStartMs: 1700000000000,
    periodEndMs: 1700086400000,
    status: "complete",
    createdAt: 1700086400000,
    updatedAt: 1700086400000,
  },
  sections: [
    {
      sourceId: "s1",
      connectorId: "telegram",
      feedId: "f1",
      feedName: "Active Feed",
      feedRemoved: false,
      content: {
        kind: "aggregate",
        points: [{ text: "bullet one", sourceUrl: null }],
      },
    },
    {
      sourceId: "s1",
      connectorId: "telegram",
      feedId: "f2",
      feedName: "Deleted Feed",
      feedRemoved: true,
      content: {
        kind: "aggregate",
        points: [{
          text: "historical bullet",
          sourceUrl: "https://example.com",
        }],
      },
    },
  ],
  groups: [
    {
      sourceId: "s1",
      connectorId: "telegram",
      sections: [
        {
          sourceId: "s1",
          connectorId: "telegram",
          feedId: "f1",
          feedName: "Active Feed",
          feedRemoved: false,
          content: {
            kind: "aggregate",
            points: [{ text: "bullet one", sourceUrl: null }],
          },
        },
        {
          sourceId: "s1",
          connectorId: "telegram",
          feedId: "f2",
          feedName: "Deleted Feed",
          feedRemoved: true,
          content: {
            kind: "aggregate",
            points: [{
              text: "historical bullet",
              sourceUrl: "https://example.com",
            }],
          },
        },
      ],
    },
  ],
  paidPosts: [],
  failureReason: null,
};

const failedView: DigestView = {
  ...sampleView,
  digest: {
    ...sampleView.digest,
    status: "failed",
  },
  failureReason: "The digest run could not complete safely.",
};

const failedWithoutReasonView: DigestView = {
  ...failedView,
  failureReason: null,
};

const completeWithReasonView: DigestView = {
  ...sampleView,
  failureReason: "This reason must stay hidden for complete digests.",
};

const noopOnAuthError = () => {};
const noopOnDeleteDigest = async (_id: string) => {};

describe("DigestViewContent rendering", () => {
  it("renders legacy connector groups, feed names, and removed feed markers", () => {
    const { getByRole, getByText } = render(() => (
      <DigestViewContent view={sampleView} onAuthError={noopOnAuthError} />
    ));

    expect(getByRole("heading", { level: 2, name: /Telegram/ })).toBeDefined();
    expect(getByRole("heading", { name: "Active Feed" })).toBeDefined();
    expect(getByRole("heading", { name: /Deleted Feed/ })).toBeDefined();
    expect(getByText("(removed)")).toBeDefined();
    expect(getByText("bullet one")).toBeDefined();
    expect(getByText("historical bullet")).toBeDefined();
  });

  it("shows an empty coverage notice when no content is available", () => {
    const { getByRole } = render(() => (
      <DigestViewContent
        view={{ ...sampleView, sections: [], groups: [], stories: [] }}
        onAuthError={noopOnAuthError}
      />
    ));

    expect(getByRole("status")).toHaveTextContent(
      "No coverage was available for this period.",
    );
  });

  it("shows the exact failure reason for a failed digest", () => {
    const { getByRole } = render(() => (
      <DigestViewContent view={failedView} onAuthError={noopOnAuthError} />
    ));

    const alert = getByRole("alert");
    expect(alert.textContent).toBe(
      `Failure reason: ${failedView.failureReason}`,
    );
  });

  it("hides failure reasons for complete or reason-less digests", () => {
    const complete = render(() => (
      <DigestViewContent
        view={completeWithReasonView}
        onAuthError={noopOnAuthError}
      />
    ));
    expect(complete.queryByRole("alert")).toBeNull();
    complete.unmount();

    const failedWithoutReason = render(() => (
      <DigestViewContent
        view={failedWithoutReasonView}
        onAuthError={noopOnAuthError}
      />
    ));
    expect(failedWithoutReason.queryByRole("alert")).toBeNull();
  });
});

const completedRun: PublicDigestRun = {
  id: "run-1",
  digestId: "digest-1",
  userId: "u1",
  trigger: "manual",
  periodStartMs: 1700000000000,
  periodEndMs: 1700086400000,
  status: "complete",
  startedAt: 1700000000000,
  finishedAt: 1700086400000,
  errorMessage: null,
};

const runWithoutDigest: PublicDigestRun = {
  id: "run-2",
  digestId: null,
  userId: "u1",
  trigger: "scheduled",
  periodStartMs: 1700086400000,
  periodEndMs: 1700172800000,
  status: "failed",
  startedAt: 1700086400000,
  finishedAt: null,
  errorMessage: "something went wrong",
};

const makeRunsPanelProps = (runs: PublicDigestRun[]) => ({
  runs,
  onSelectRun: (id: string): Promise<DigestRunDetail> =>
    Promise.resolve({
      run: runs.find((run) => run.id === id) ?? runs[0],
      feeds: [],
    }),
  onRefresh: async () => {},
  onAuthError: () => {},
});

describe("DigestRunsPanel issue link", () => {
  it("renders Read digest link to the issue reader when digestId is set", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun])} />
    ));
    const link = getByText("Read digest");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/issues/digest-1");
  });

  it("does not render Read digest link when digestId is null", () => {
    const { queryByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([runWithoutDigest])} />
    ));
    expect(queryByText("Read digest")).toBeNull();
  });

  it("links only the run with a digest in a mixed list", () => {
    const { getAllByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun, runWithoutDigest])} />
    ));
    const links = getAllByText("Read digest");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/issues/digest-1");
  });

  it("shows current run titles and status labels", () => {
    const { getAllByText, getByText, queryByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun, runWithoutDigest])} />
    ));
    expect(getByText("Digest prepared")).toBeDefined();
    expect(getByText("Digest run")).toBeDefined();
    expect(getAllByText("Ready").length).toBeGreaterThan(0);
    expect(getAllByText("failed").length).toBeGreaterThan(0);
    expect(queryByText("Digest in progress")).toBeNull();
  });

  it("offers technical details and feed diagnostics for every run", () => {
    const { getAllByText, getAllByRole } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun, runWithoutDigest])} />
    ));
    const summaries = getAllByText("Technical details");
    expect(summaries).toHaveLength(2);
    summaries.forEach((summary) =>
      expect(summary.closest("details")).not.toHaveAttribute("open")
    );
    expect(getAllByRole("button", { name: "Load feed diagnostics" }))
      .toHaveLength(2);
  });
});

describe("DigestRunsPanel diagnostics", () => {
  it("loads feed diagnostics after opening the technical disclosure", async () => {
    const { getByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun])} />
    ));
    const summary = getByText("Technical details");
    await fireEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");

    const runArticle = summary.closest("article")!;
    const scoped = within(runArticle);
    await fireEvent.click(
      scoped.getByRole("button", { name: "Load feed diagnostics" }),
    );
    await waitFor(() =>
      expect(scoped.getByText("0 feed steps recorded")).toBeVisible()
    );
    expect(scoped.getByText("Feed steps").nextElementSibling)
      .toHaveTextContent("0");
    expect(scoped.getByText("Finished")).toBeDefined();
  });

  it("explains failed runs inside their technical disclosure", async () => {
    const { getAllByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun, runWithoutDigest])} />
    ));
    const summaries = getAllByText("Technical details");
    await fireEvent.click(summaries[1]);

    const scoped = within(summaries[1].closest("article")!);
    expect(scoped.getByText("something went wrong")).toBeVisible();
    expect(scoped.queryByText("Finished")).toBeNull();
  });
});

const sampleDigests: PublicDigest[] = [
  {
    id: "d-1",
    userId: "u1",
    periodStartMs: 1_702_000_000_000,
    periodEndMs: 1_702_086_400_000,
    status: "complete",
    createdAt: 1_702_100_000_000,
    updatedAt: 1_702_100_000_000,
    latestRunStartedAt: 1_702_100_000_000,
    latestRunFinishedAt: 1_702_100_065_000,
  },
  {
    id: "d-2",
    userId: "u1",
    periodStartMs: 1_701_000_000_000,
    periodEndMs: 1_701_086_400_000,
    status: "failed",
    createdAt: 1_701_100_000_000,
    updatedAt: 1_701_100_000_000,
  },
];

const pendingDigest: PublicDigest = {
  id: "d-3",
  userId: "u1",
  periodStartMs: 1_703_000_000_000,
  periodEndMs: 1_703_086_400_000,
  status: "pending",
  createdAt: 1_703_100_000_000,
  updatedAt: 1_703_100_000_000,
};

function makeDigestsPanelProps(
  overrides: { onDeleteDigest?: (id: string) => Promise<void> } = {},
) {
  return {
    digests: sampleDigests,
    onDeleteDigest: overrides.onDeleteDigest ?? noopOnDeleteDigest,
    onAuthError: noopOnAuthError,
  };
}

describe("DigestsPanel archive links", () => {
  it("links completed issues to the reader at /issues/:id", () => {
    const { getAllByRole, getByRole } = render(() => (
      <DigestsPanel
        digests={[sampleDigests[0]]}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));
    const link = getByRole("link", { name: /read digest$/ });
    expect(link.getAttribute("href")).toBe("/issues/d-1");
    expect(getAllByRole("link")).toHaveLength(1);
  });

  it("keeps failed issues unlinked and explains the failure", () => {
    const { container, getByText, queryByText } = render(() => (
      <DigestsPanel
        digests={[sampleDigests[1]]}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));
    expect(
      getByText(
        "The latest request did not finish. Review runs in Profile for technical details, then try again when ready.",
      ),
    ).toHaveAttribute("role", "status");
    expect(container.querySelector('a[href^="/issues/"]')).toBeNull();
    expect(
      queryByText(
        "This briefing is being prepared. It will appear here when the run finishes.",
      ),
    ).toBeNull();
  });

  it("explains pending issues while they are being prepared", () => {
    const { getByText } = render(() => (
      <DigestsPanel
        digests={[pendingDigest]}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));
    expect(
      getByText(
        "This briefing is being prepared. It will appear here when the run finishes.",
      ),
    ).toHaveAttribute("role", "status");
    expect(getByText("Issue 1")).toBeDefined();
  });
});

describe("DigestsPanel issue numbering", () => {
  it("numbers issues in list order", () => {
    const { getAllByText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} />
    ));

    const ordinals = getAllByText(/^Issue \d+$/);
    expect(ordinals).toHaveLength(2);
    expect(ordinals[0].textContent).toBe("Issue 1");
    expect(ordinals[1].textContent).toBe("Issue 2");
  });
});

describe("DigestsPanel request and coverage metadata", () => {
  it("shows the latest request time and preparation duration with a created-at fallback", () => {
    const { container, getAllByText, getByText, queryByText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} />
    ));

    expect(getAllByText("Latest request")).toHaveLength(2);
    expect(getAllByText("Preparation")).toHaveLength(1);
    expect(getByText("1m 5s")).toBeTruthy();
    expect(
      container.querySelector(
        `time[datetime="${new Date(1_702_100_000_000).toISOString()}"]`,
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        `time[datetime="${new Date(1_701_100_000_000).toISOString()}"]`,
      ),
    ).toBeTruthy();
    expect(queryByText("Created")).toBeNull();
  });
});

describe("DigestsPanel delete button", () => {
  it("keeps delete secondary inside the issue actions disclosure", () => {
    const { getAllByRole, getAllByText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} />
    ));

    expect(getAllByText("Issue actions")).toHaveLength(2);
    const deleteButtons = getAllByRole("button", { name: "Delete digest" });
    expect(deleteButtons).toHaveLength(2);
    deleteButtons.forEach((button) =>
      expect(
        button.closest("details")?.querySelector("summary")?.textContent,
      ).toBe("Issue actions")
    );
  });

  it("calls onDeleteDigest when confirm returns true", async () => {
    const originalConfirm = globalThis.confirm;
    try {
      globalThis.confirm = (() => true) as typeof confirm;
      let calledWith: string | null = null;
      const { getAllByRole, getAllByText } = render(() => (
        <DigestsPanel
          {...makeDigestsPanelProps({
            onDeleteDigest: (digestId: string) => {
              calledWith = digestId;
              return Promise.resolve();
            },
          })}
        />
      ));
      await fireEvent.click(getAllByText("Issue actions")[0]);
      getAllByRole("button", { name: "Delete digest" })[0].click();
      expect(calledWith).toBe("d-1");
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  it("does not call onDeleteDigest when confirm returns false", async () => {
    const originalConfirm = globalThis.confirm;
    try {
      globalThis.confirm = (() => false) as typeof confirm;
      let called = false;
      const { getAllByRole } = render(() => (
        <DigestsPanel
          {...makeDigestsPanelProps({
            onDeleteDigest: () => {
              called = true;
              return Promise.resolve();
            },
          })}
        />
      ));
      await fireEvent.click(getAllByRole("button", { name: "Delete digest" })[0]);
      expect(called).toBe(false);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });
});

describe("DigestsPanel sorting", () => {
  it("exposes every digest sort and reports changes", () => {
    const onSortChange = vi.fn();
    const { getByLabelText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} onSortChange={onSortChange} />
    ));

    const select = getByLabelText("Order by") as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      "Newest requested",
      "Oldest requested",
      "Latest coverage",
      "Earliest coverage",
    ]);
    expect(select.value).toBe("requested_desc");
    fireEvent.change(select, { target: { value: "period_asc" } });
    expect(onSortChange).toHaveBeenCalledWith("period_asc");
  });

  it("hides the sort control without an onSortChange handler", () => {
    const { queryByLabelText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} />
    ));
    expect(queryByLabelText("Order by")).toBeNull();
  });
});

describe("DigestsPanel Load more", () => {
  it("does not render Load more issues when nextCursor is undefined", () => {
    const { queryByText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} />
    ));
    expect(queryByText("Load more issues")).toBeNull();
  });

  it("renders Load more issues when nextCursor is set", () => {
    const { getByText } = render(() => (
      <DigestsPanel {...makeDigestsPanelProps()} nextCursor="abc123" />
    ));
    expect(getByText("Load more issues")).toBeDefined();
  });

  it("disables Load more issues while loadingMore is true", () => {
    const { getByText } = render(() => (
      <DigestsPanel
        {...makeDigestsPanelProps()}
        nextCursor="abc123"
        loadingMore
      />
    ));
    const button = getByText("Loading archive…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onLoadMore when Load more issues is clicked", () => {
    let called = false;
    const { getByText } = render(() => (
      <DigestsPanel
        {...makeDigestsPanelProps()}
        nextCursor="abc123"
        onLoadMore={() => {
          called = true;
          return Promise.resolve();
        }}
      />
    ));
    getByText("Load more issues").click();
    expect(called).toBe(true);
  });
});

describe("DigestRunsPanel Load more", () => {
  it("does not render Load more activity when nextCursor is undefined", () => {
    const { queryByText } = render(() => (
      <DigestRunsPanel {...makeRunsPanelProps([completedRun])} />
    ));
    expect(queryByText("Load more activity")).toBeNull();
  });

  it("renders Load more activity when nextCursor is set", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel
        {...makeRunsPanelProps([completedRun])}
        nextCursor="abc123"
      />
    ));
    expect(getByText("Load more activity")).toBeDefined();
  });

  it("disables Load more activity while loadingMore is true", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel
        {...makeRunsPanelProps([completedRun])}
        nextCursor="abc123"
        loadingMore
      />
    ));
    const button = getByText("Loading more activity…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onLoadMore when Load more activity is clicked", () => {
    let called = false;
    const { getByText } = render(() => (
      <DigestRunsPanel
        {...makeRunsPanelProps([completedRun])}
        nextCursor="abc123"
        onLoadMore={() => {
          called = true;
          return Promise.resolve();
        }}
      />
    ));
    getByText("Load more activity").click();
    expect(called).toBe(true);
  });
});

const mixedContentView = {
  digest: sampleDigests[0],
  sections: [
    {
      sourceId: "telegram-source",
      connectorId: "Telegram",
      feedId: "telegram-feed",
      feedName: "Telegram channel",
      feedRemoved: false,
      content: {
        kind: "aggregate",
        points: [
          { text: "Telegram stays flat", sourceUrl: "https://t.me/example" },
        ],
      },
    },
    {
      sourceId: "substack-source",
      connectorId: "Substack",
      feedId: "substack-feed",
      feedName: "Substack publication",
      feedRemoved: false,
      content: {
        kind: "articles",
        articles: [
          {
            sourceExternalId: "article-1",
            title: "First article",
            sourceUrl: "https://example.com/first",
            publishedAt: 1_704_067_200_000,
            contentAccess: "preview",
            points: [
              { text: "First article point", sourceUrl: null },
            ],
          },
          {
            sourceExternalId: "article-2",
            title: "Second article",
            sourceUrl: null,
            publishedAt: 1_704_153_600_000,
            contentAccess: "full",
            points: [],
          },
        ],
      },
    },
    {
      sourceId: "substack-source",
      connectorId: "Substack",
      feedId: "empty-feed",
      feedName: "Empty publication",
      feedRemoved: false,
      content: { kind: "articles", articles: [] },
    },
    {
      sourceId: "telegram-source",
      connectorId: "Telegram",
      feedId: "removed-feed",
      feedName: "Removed channel",
      feedRemoved: true,
      content: {
        kind: "aggregate",
        points: [{ text: "Historical point", sourceUrl: null }],
      },
    },
  ],
  groups: [
    {
      sourceId: "telegram-source",
      connectorId: "Telegram",
      sections: [
        {
          sourceId: "telegram-source",
          connectorId: "Telegram",
          feedId: "telegram-feed",
          feedName: "Telegram channel",
          feedRemoved: false,
          content: {
            kind: "aggregate",
            points: [
              {
                text: "Telegram stays flat",
                sourceUrl: "https://t.me/example",
              },
            ],
          },
        },
        {
          sourceId: "telegram-source",
          connectorId: "Telegram",
          feedId: "removed-feed",
          feedName: "Removed channel",
          feedRemoved: true,
          content: {
            kind: "aggregate",
            points: [{ text: "Historical point", sourceUrl: null }],
          },
        },
      ],
    },
    {
      sourceId: "substack-source",
      connectorId: "Substack",
      sections: [
        {
          sourceId: "substack-source",
          connectorId: "Substack",
          feedId: "substack-feed",
          feedName: "Substack publication",
          feedRemoved: false,
          content: {
            kind: "articles",
            articles: [
              {
                sourceExternalId: "article-1",
                title: "First article",
                sourceUrl: "https://example.com/first",
                publishedAt: 1_704_067_200_000,
                contentAccess: "preview",
                points: [
                  {
                    text: "First article point",
                    sourceUrl: "https://example.com/first#point",
                  },
                ],
              },
              {
                sourceExternalId: "article-2",
                title: "Second article",
                sourceUrl: null,
                publishedAt: 1_704_153_600_000,
                contentAccess: "full",
                points: [],
              },
            ],
          },
        },
        {
          sourceId: "substack-source",
          connectorId: "Substack",
          feedId: "empty-feed",
          feedName: "Empty publication",
          feedRemoved: false,
          content: { kind: "articles", articles: [] },
        },
      ],
    },
  ],
  paidPosts: [],
  failureReason: null,
} as unknown as DigestView;

describe("DigestViewContent tagged digest content", () => {
  it("renders aggregate points and article content without crossing article boundaries", () => {
    const { getByText, getByRole, queryByText, container } = render(() => (
      <DigestViewContent view={mixedContentView} onAuthError={noopOnAuthError} />
    ));

    expect(getByText("Telegram stays flat")).toBeDefined();
    expect(getByRole("heading", { name: "Telegram channel" })).toBeDefined();
    expect(getByRole("heading", { name: "Substack publication" }))
      .toBeDefined();
    expect(getByRole("heading", { name: "First article" })).toBeDefined();
    expect(getByRole("heading", { name: "Second article" })).toBeDefined();
    expect(getByText("First article point")).toBeDefined();
    expect(queryByText("Telegram stays flat", { selector: "h3, h4" }))
      .toBeNull();
    expect(container.querySelectorAll("article")).toHaveLength(2);
  });

  it("links article titles without redundant point sources or empty publications", () => {
    const {
      getAllByRole,
      getByRole,
      getByText,
      queryByRole,
      queryByText,
      container,
    } = render(() => (
      <DigestViewContent view={mixedContentView} onAuthError={noopOnAuthError} />
    ));

    const articleLink = getByRole("link", { name: "First article" });
    expect(articleLink.getAttribute("href")).toBe("https://example.com/first");
    expect(articleLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(getByText("Preview")).toBeDefined();
    expect(getByText("No points available for this article.")).toBeDefined();
    expect(queryByText("No articles available.")).toBeNull();
    expect(queryByRole("heading", { name: "Empty publication" })).toBeNull();
    expect(getAllByRole("link", { name: "source" })).toHaveLength(1);
    expect(getByText("(removed)")).toBeDefined();
    expect(container.querySelectorAll("article time")).toHaveLength(2);
  });

  it("does not show a paid-post list when the digest has none", () => {
    const { getByRole, queryByRole } = render(() => (
      <DigestViewContent view={sampleView} onAuthError={noopOnAuthError} />
    ));

    expect(getByRole("heading", { name: "Active Feed" })).toBeDefined();
    expect(queryByRole("heading", { name: "Paid posts" })).toBeNull();
  });

  it("groups paid titles by newsletter in first-appearance and post order", () => {
    const view = {
      ...sampleView,
      paidPosts: [
        {
          newsletterName: "The Linked Ledger",
          title: "Linked paid title",
          sourceUrl: "https://example.substack.com/p/linked",
          publishedAt: 1_704_240_000_000,
          preview: "Paid preview must not render",
          body: "Paid body must not render",
        },
        {
          newsletterName: "The Linked Ledger",
          title: "Second linked paid title",
          sourceUrl: "https://example.substack.com/p/second-linked",
          publishedAt: 1_704_283_200_000,
        },
        {
          newsletterName: "Plainspoken Weekly",
          title: "Plain paid title",
          sourceUrl: null,
          publishedAt: 1_704_326_400_000,
        },
        {
          newsletterName: "Unsafe URL Review",
          title: "Unsafe paid title",
          sourceUrl: "javascript:alert(document.domain)",
          publishedAt: 1_704_412_800_000,
        },
      ],
    } as unknown as DigestView;
    const { getByRole, getByText, queryByText, container } = render(() => (
      <DigestViewContent view={view} onAuthError={noopOnAuthError} />
    ));

    const paidPosts = container.querySelector<HTMLElement>(".paid-posts")!;
    const newsletterHeadings = Array.from(
      paidPosts.querySelectorAll<HTMLHeadingElement>("h3"),
    );
    const newsletterLists = Array.from(
      paidPosts.querySelectorAll<HTMLUListElement>("ul.paid-post-list"),
    );
    expect(newsletterHeadings.map((heading) => heading.textContent)).toEqual([
      "The Linked Ledger",
      "Plainspoken Weekly",
      "Unsafe URL Review",
    ]);
    expect(newsletterLists).toHaveLength(3);
    expect(
      newsletterLists.map((list) =>
        Array.from(list.querySelectorAll("li")).map((item) => item.textContent)
      ),
    ).toEqual([
      ["Linked paid title", "Second linked paid title"],
      ["Plain paid title"],
      ["Unsafe paid title"],
    ]);
    newsletterHeadings.forEach((heading, index) => {
      expect(newsletterLists[index].getAttribute("aria-labelledby")).toBe(
        heading.id,
      );
    });
    expect(
      new Set(newsletterHeadings.map((heading) => heading.textContent)).size,
    )
      .toBe(3);

    const linkedTitle = getByRole("link", { name: "Linked paid title" });
    expect(linkedTitle.getAttribute("href")).toBe(
      "https://example.substack.com/p/linked",
    );
    expect(linkedTitle.parentElement?.textContent).toBe("Linked paid title");
    const secondLinkedTitle = getByRole("link", {
      name: "Second linked paid title",
    });
    expect(secondLinkedTitle.getAttribute("href")).toBe(
      "https://example.substack.com/p/second-linked",
    );
    expect(queryByText("Plain paid title", { selector: "a" })).toBeNull();
    expect(queryByText("Unsafe paid title", { selector: "a" })).toBeNull();
    expect(paidPosts.querySelector('a[href^="javascript:"]')).toBeNull();
    const lastNormalContent = getByText("historical bullet");
    const paidHeading = getByRole("heading", { name: "Paid posts" });
    expect(
      lastNormalContent.compareDocumentPosition(paidHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(queryByText("Paid preview must not render")).toBeNull();
    expect(queryByText("Paid body must not render")).toBeNull();
    expect(queryByText("Preview")).toBeNull();
    expect(queryByText("No points available for this article.")).toBeNull();
    expect(container.querySelector(".paid-posts article")).toBeNull();
  });
});
