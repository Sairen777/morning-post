/** @jsxImportSource solid-js */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { ApiClientError } from "../api/client";
import type { DigestView, PublicDigestRun } from "../api/types";
import DigestRunnerCard from "./DigestRunnerCard";

const activeRun: PublicDigestRun = {
  id: "run-active",
  digestId: null,
  userId: "user-1",
  trigger: "manual",
  periodStartMs: 1_700_000_000_000,
  periodEndMs: 1_700_086_400_000,
  status: "running",
  startedAt: 1_700_000_123_000,
  finishedAt: null,
  errorMessage: null,
};

const completedDigest: DigestView = {
  digest: {
    id: "digest-1",
    userId: "user-1",
    periodStartMs: 1_700_000_000_000,
    periodEndMs: 1_700_086_400_000,
    status: "complete",
    createdAt: 1_700_086_400_000,
    updatedAt: 1_700_086_400_000,
  },
  sections: [],
  groups: [],
  paidPosts: [],
  failureReason: null,
};

function renderCard(
  overrides: Partial<Parameters<typeof DigestRunnerCard>[0]> = {},
) {
  return render(() => (
    <DigestRunnerCard
      onRun={async () => completedDigest}
      onAuthError={() => {}}
      activeRun={undefined}
      isCheckingRunStatus={false}
      runStatusError={null}
      onRefreshRunStatus={async () => {}}
      onOpenRuns={() => {}}
      {...overrides}
    />
  ));
}

describe("DigestRunnerCard active run recovery", () => {
  it("disables submission, explains the active run, and opens Runs", async () => {
    const onOpenRuns = vi.fn();
    renderCard({ activeRun, onOpenRuns });

    expect(screen.getByRole("button", { name: "Run digest" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "A digest is running.",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Started");

    await fireEvent.click(
      screen.getByRole("button", { name: "Open Runs tab" }),
    );
    expect(onOpenRuns).toHaveBeenCalledOnce();
  });

  it("waits for run refresh after a 409 before showing friendly wording", async () => {
    let resolveRefresh!: () => void;
    const onRefreshRunStatus = vi.fn(() =>
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const onRun = vi.fn(() =>
      Promise.reject(
        new ApiClientError(
          409,
          "DIGEST_ALREADY_RUNNING",
          "digest already running",
        ),
      )
    );
    renderCard({ onRun, onRefreshRunStatus });

    await fireEvent.click(screen.getByRole("button", { name: "Run digest" }));
    await waitFor(() => expect(onRefreshRunStatus).toHaveBeenCalledOnce());
    expect(screen.queryByText(/digest already running$/i)).toBeNull();

    resolveRefresh();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A digest is already running. Wait for it to finish before starting another digest.",
      )
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "DIGEST_ALREADY_RUNNING",
    );
  });

  it("shows the sanitized reason from an immediately failed digest", async () => {
    const failureReason = "The digest run could not complete safely.";
    const failedDigest: DigestView = {
      ...completedDigest,
      digest: { ...completedDigest.digest, status: "failed" },
      failureReason,
    };
    renderCard({ onRun: async () => failedDigest });

    await fireEvent.click(screen.getByRole("button", { name: "Run digest" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(failureReason)
    );
  });

  it("shows a safe generic error when an immediately failed digest has no reason", async () => {
    const failedDigest: DigestView = {
      ...completedDigest,
      digest: { ...completedDigest.digest, status: "failed" },
      failureReason: null,
    };
    renderCard({ onRun: async () => failedDigest });

    await fireEvent.click(screen.getByRole("button", { name: "Run digest" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The digest run failed. Please try again.",
      )
    );
  });
});
