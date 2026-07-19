/** @jsxImportSource solid-js */
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import StatusBadge from "../app/StatusBadge";
import FormatTime from "../app/FormatTime";
import ProfilePanel from "../app/ProfilePanel";
import SourcesPanel from "../app/SourcesPanel";

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
      email: "ada@example.com",
      systemPrompt: "Summarize plainly.",
      defaultLanguage: null,
      createdAt: 0,
      updatedAt: 0,
    };
    const { container } = render(() => (
      <ProfilePanel
        user={user}
        onSave={() => Promise.resolve(user)}
        onSaved={() => {}}
        onAuthError={() => {}}
      />
    ));
    expect(container.querySelector("#profile-model")).toBeNull();
    expect(container.querySelector("#profile-name")).not.toBeNull();
    expect(container.querySelector("#profile-language")).not.toBeNull();
    expect(container.querySelector("#profile-prompt")).not.toBeNull();
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
    createdAt: 0,
    updatedAt: 0,
  } as const;

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
