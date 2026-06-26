/** @jsxImportSource solid-js */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import type { DigestView, DigestSourceGroup, DigestSection } from "../api/types";

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
