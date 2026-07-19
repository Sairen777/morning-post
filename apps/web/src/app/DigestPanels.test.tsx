/** @jsxImportSource solid-js */
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { waitFor } from "@solidjs/testing-library";
import type {
  DigestRunDetail,
  DigestView,
  PublicDigestRun,
} from "../api/types";
import DigestRunsPanel from "./DigestRunsPanel";
import DigestsPanel from "./DigestsPanel";
import type { PublicDigest } from "../api/types";

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
};

describe("DigestDetail rendering", () => {
  it("renders connector group and feed names", async () => {
    const { container, getByRole } = render(() => (
      <DigestsPanel
        digests={[sampleView.digest]}
        onSelectDigest={() => Promise.resolve(sampleView)}
        onDeleteDigest={async () => {}}
        onAuthError={() => {}}
      />
    ));
    getByRole("button", { name: /#1/ }).click();
    await waitFor(() => expect(container.textContent).toContain("telegram"));
    expect(container.textContent).toContain("Active Feed");
    expect(container.textContent).toContain("bullet one");
  });

  it("renders removed feed marker", async () => {
    const { container, getByRole } = render(() => (
      <DigestsPanel
        digests={[sampleView.digest]}
        onSelectDigest={() => Promise.resolve(sampleView)}
        onDeleteDigest={async () => {}}
        onAuthError={() => {}}
      />
    ));
    getByRole("button", { name: /#1/ }).click();
    await waitFor(() => expect(container.textContent).toContain("(removed)"));
    expect(container.textContent).toContain("historical bullet");
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

describe("DigestRunsPanel digest link", () => {
  const noop = async () => {};
  const makeProps = (runs: PublicDigestRun[]) => ({
    runs,
    onSelectRun: (id: string): Promise<DigestRunDetail> =>
      Promise.resolve({
        run: runs.find((run) => run.id === id) ?? runs[0],
        feeds: [],
      }),
    onRefresh: noop,
    onAuthError: noop,
  });

  it("renders Open digest link when digestId is set", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel {...makeProps([completedRun])} />
    ));
    const link = getByText("Open digest");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/digests/digest-1.md");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not render Open digest link when digestId is null", () => {
    const { queryByText } = render(() => (
      <DigestRunsPanel {...makeProps([runWithoutDigest])} />
    ));
    expect(queryByText("Open digest")).toBeNull();
  });

  it("renders link for run with digestId but not for run without in mixed list", () => {
    const { getAllByText } = render(() => (
      <DigestRunsPanel {...makeProps([completedRun, runWithoutDigest])} />
    ));
    const links = getAllByText("Open digest");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(
      "/digests/digest-1.md",
    );
  });

  it("preserves View run details button", () => {
    const { getAllByText } = render(() => (
      <DigestRunsPanel {...makeProps([completedRun, runWithoutDigest])} />
    ));
    const buttons = getAllByText("View run details");
    expect(buttons).toHaveLength(2);
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

const noopOnAuthError = () => {};
const noopOnDeleteDigest = async (_id: string) => {};

function makeDigestsPanelProps(
  overrides: { onDeleteDigest?: (id: string) => Promise<void> } = {},
) {
  return {
    digests: sampleDigests,
    onSelectDigest: () =>
      Promise.resolve({
        digest: sampleDigests[0],
        sections: [],
        groups: [],
      }),
    onDeleteDigest: overrides.onDeleteDigest ?? noopOnDeleteDigest,
    onAuthError: noopOnAuthError,
  };
}

describe("DigestsPanel ordinal numbering", () => {
  it("renders #1 and #2 in list order", () => {
    const { getAllByText } = render(() => (
      <DigestsPanel
        digests={sampleDigests}
        onSelectDigest={() =>
          Promise.resolve({
            digest: sampleDigests[0],
            sections: [],
            groups: [],
          })}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));

    const ordinals = getAllByText(/^#\d+$/);
    expect(ordinals).toHaveLength(2);
    expect(ordinals[0].textContent).toBe("#1");
    expect(ordinals[1].textContent).toBe("#2");
  });
});

describe("DigestsPanel delete button", () => {
  it("calls onDeleteDigest when confirm returns true", () => {
    const originalConfirm = globalThis.confirm;
    try {
      globalThis.confirm = (() => true) as typeof confirm;
      let calledWith: string | null = null;
      const { getAllByText } = render(() => (
        <DigestsPanel
          {...makeDigestsPanelProps({
            onDeleteDigest: (digestId: string) => {
              calledWith = digestId;
              return Promise.resolve();
            },
          })}
        />
      ));
      const buttons = getAllByText("Delete digest");
      // The first row's delete button
      buttons[0].click();
      expect(calledWith).toBe("d-1");
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  it("does not call onDeleteDigest when confirm returns false", () => {
    const originalConfirm = globalThis.confirm;
    try {
      globalThis.confirm = (() => false) as typeof confirm;
      let called = false;
      const { getAllByText } = render(() => (
        <DigestsPanel
          {...makeDigestsPanelProps({
            onDeleteDigest: () => {
              called = true;
              return Promise.resolve();
            },
          })}
        />
      ));
      const buttons = getAllByText("Delete digest")[0];
      buttons.click();
      expect(called).toBe(false);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });
});

describe("DigestsPanel Load more", () => {
  const noopSelect = () =>
    Promise.resolve({
      digest: sampleDigests[0],
      sections: [],
      groups: [],
    });
  const noopDelete = async (_id: string) => {};
  const noopAuth = () => {};

  it("does not render Load more when nextCursor is undefined", () => {
    const { queryByText } = render(() => (
      <DigestsPanel
        digests={sampleDigests}
        onSelectDigest={noopSelect}
        onDeleteDigest={noopDelete}
        onAuthError={noopAuth}
      />
    ));
    expect(queryByText("Load more")).toBeNull();
  });

  it("renders Load more when nextCursor is set", () => {
    const { getByText, queryByText } = render(() => (
      <DigestsPanel
        digests={sampleDigests}
        onSelectDigest={noopSelect}
        onDeleteDigest={noopDelete}
        onAuthError={noopAuth}
        nextCursor="abc123"
      />
    ));
    expect(getByText("Load more")).toBeDefined();
    expect(queryByText("Load more")).not.toBeNull();
  });

  it("disables Load more button when loadingMore is true", () => {
    const { getByText } = render(() => (
      <DigestsPanel
        digests={sampleDigests}
        onSelectDigest={noopSelect}
        onDeleteDigest={noopDelete}
        onAuthError={noopAuth}
        nextCursor="abc123"
        loadingMore
      />
    ));
    const button = getByText("Loading…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onLoadMore when Load more is clicked", () => {
    let called = false;
    const { getByText } = render(() => (
      <DigestsPanel
        digests={sampleDigests}
        onSelectDigest={noopSelect}
        onDeleteDigest={noopDelete}
        onAuthError={noopAuth}
        nextCursor="abc123"
        onLoadMore={() => {
          called = true;
          return Promise.resolve();
        }}
      />
    ));
    getByText("Load more").click();
    expect(called).toBe(true);
  });
});

describe("DigestRunsPanel Load more", () => {
  const noopSelect = (_digestId: string) =>
    Promise.resolve({
      run: completedRun,
      feeds: [],
    });
  const noopRefresh = async () => {};
  const noopAuth = () => {};

  it("does not render Load more when nextCursor is undefined", () => {
    const { queryByText } = render(() => (
      <DigestRunsPanel
        runs={[completedRun]}
        onSelectRun={noopSelect}
        onRefresh={noopRefresh}
        onAuthError={noopAuth}
      />
    ));
    expect(queryByText("Load more")).toBeNull();
  });

  it("renders Load more when nextCursor is set", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel
        runs={[completedRun]}
        onSelectRun={noopSelect}
        onRefresh={noopRefresh}
        onAuthError={noopAuth}
        nextCursor="abc123"
      />
    ));
    expect(getByText("Load more")).toBeDefined();
  });

  it("disables Load more button when loadingMore is true", () => {
    const { getByText } = render(() => (
      <DigestRunsPanel
        runs={[completedRun]}
        onSelectRun={noopSelect}
        onRefresh={noopRefresh}
        onAuthError={noopAuth}
        nextCursor="abc123"
        loadingMore
      />
    ));
    const button = getByText("Loading…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("calls onLoadMore when Load more is clicked", () => {
    let called = false;
    const { getByText } = render(() => (
      <DigestRunsPanel
        runs={[completedRun]}
        onSelectRun={noopSelect}
        onRefresh={noopRefresh}
        onAuthError={noopAuth}
        nextCursor="abc123"
        onLoadMore={() => {
          called = true;
          return Promise.resolve();
        }}
      />
    ));
    getByText("Load more").click();
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
      ],
    },
  ],
} as unknown as DigestView;

describe("DigestsPanel tagged digest content", () => {
  it("renders aggregate points and article content without crossing article boundaries", async () => {
    const { getByText, getByRole, queryByText, container } = render(() => (
      <DigestsPanel
        digests={[sampleDigests[0]]}
        onSelectDigest={() => Promise.resolve(mixedContentView)}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));

    getByRole("button", { name: /#1/ }).click();
    await waitFor(() =>
      expect(getByRole("heading", { name: "First article" })).toBeDefined()
    );

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

  it("links article titles, labels previews, formats dates, and explains empty states", async () => {
    const { getByRole, getByText, container } = render(() => (
      <DigestsPanel
        digests={[sampleDigests[0]]}
        onSelectDigest={() => Promise.resolve(mixedContentView)}
        onDeleteDigest={noopOnDeleteDigest}
        onAuthError={noopOnAuthError}
      />
    ));

    getByRole("button", { name: /#1/ }).click();
    await waitFor(() =>
      expect(getByRole("heading", { name: "First article" })).toBeDefined()
    );

    const articleLink = getByRole("link", { name: "First article" });
    expect(articleLink.getAttribute("href")).toBe("https://example.com/first");
    expect(articleLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(getByText("Preview")).toBeDefined();
    expect(getByText("No points available for this article.")).toBeDefined();
    expect(getByText("No articles available.")).toBeDefined();
    expect(getByText("(removed)")).toBeDefined();
    expect(container.querySelectorAll("article time")).toHaveLength(2);
  });
});
