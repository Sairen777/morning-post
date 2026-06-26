/** @jsxImportSource solid-js */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import StatusBadge from "../app/StatusBadge";
import FormatTime from "../app/FormatTime";

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
