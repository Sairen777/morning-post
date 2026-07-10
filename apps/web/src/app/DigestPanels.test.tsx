/** @jsxImportSource solid-js */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import type { DigestView, PublicDigestRun, DigestRunDetail } from "../api/types";
import DigestRunsPanel from "./DigestRunsPanel";
import DigestsPanel from "./DigestsPanel";
import type { PublicDigest } from "../api/types";

// Inline a minimal digest panel renderer for testing
function DigestDetailTest(props: { view: DigestView }) {
  return (
    <div>
      {props.view.groups.map((group) => (
        <div>
          <h3>{group.connectorId}</h3>
          {group.sections.map((section) => (
            <div>
              <h4>
                {section.feedName}
                {section.feedRemoved && <span class="feed-removed"> (removed)</span>}
              </h4>
              <ul>
                {section.points.map((point) => (
                  <li>{point.text}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

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
      points: [{ text: "bullet one", sourceUrl: null }],
    },
    {
      sourceId: "s1",
      connectorId: "telegram",
      feedId: "f2",
      feedName: "Deleted Feed",
      feedRemoved: true,
      points: [{ text: "historical bullet", sourceUrl: "https://example.com" }],
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
          points: [{ text: "bullet one", sourceUrl: null }],
        },
        {
          sourceId: "s1",
          connectorId: "telegram",
          feedId: "f2",
          feedName: "Deleted Feed",
          feedRemoved: true,
          points: [{ text: "historical bullet", sourceUrl: "https://example.com" }],
        },
      ],
    },
  ],
};

describe("DigestDetail rendering", () => {
  it("renders connector group and feed names", () => {
    const { container } = render(() => <DigestDetailTest view={sampleView} />);
    expect(container.textContent).toContain("telegram");
    expect(container.textContent).toContain("Active Feed");
    expect(container.textContent).toContain("bullet one");
  });

  it("renders removed feed marker", () => {
    const { container } = render(() => <DigestDetailTest view={sampleView} />);
    expect(container.textContent).toContain("(removed)");
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

function makeDigestsPanelProps(overrides: { onDeleteDigest?: (id: string) => Promise<void> } = {}) {
  return {
    digests: sampleDigests,
    onSelectDigest: async () => ({
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
        onSelectDigest={async () => ({
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
            onDeleteDigest: async (id: string) => { calledWith = id; },
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
            onDeleteDigest: async () => { called = true; },
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
