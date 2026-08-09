/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { ApiClientError } from "../api/client";
import type { DisconnectSourceResponse, PublicSource } from "../api/types";
import ConnectionsPanel from "./ConnectionsPanel";

const connectedXSource: PublicSource = {
  id: "source-x",
  userId: "user-1",
  connectorId: "X",
  position: null,
  enabled: true,
  showPaidPostTitles: false,
  relevanceFilterMode: "inherit",
  connected: true,
  createdAt: 1,
  updatedAt: 1,
};

const disconnectResponse: DisconnectSourceResponse = {
  source: { ...connectedXSource, connected: false },
  revokeTelegramSession: false,
  message: "X source disconnected.",
};

function renderConnections(
  onDisconnectSource: (id: string) => Promise<DisconnectSourceResponse>,
  onAuthError = vi.fn(),
) {
  return render(() => (
    <ConnectionsPanel
      sources={[connectedXSource]}
      feeds={[]}
      onTelegramConnected={() => Promise.resolve()}
      onSubstackConnected={() => Promise.resolve()}
      onSubstackPublicationAdded={() => Promise.resolve()}
      onSubstackSourceUpdated={() => Promise.resolve()}
      onXConnected={() => Promise.resolve()}
      onXTargetAdded={() => Promise.resolve()}
      onDisconnectSource={onDisconnectSource}
      onAuthError={onAuthError}
    />
  ));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionsPanel disconnect", () => {
  it("does not disconnect when the destructive confirmation is canceled", async () => {
    const onDisconnectSource = vi.fn(() => Promise.resolve(disconnectResponse));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    renderConnections(onDisconnectSource);

    await fireEvent.click(screen.getByRole("button", { name: /X.*Manage connection/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Disconnect X" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Existing subscriptions will no longer contribute"),
    );
    expect(onDisconnectSource).not.toHaveBeenCalled();
  });

  it("disconnects after confirmation and reports the existing response", async () => {
    const onDisconnectSource = vi.fn(() => Promise.resolve(disconnectResponse));
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderConnections(onDisconnectSource);

    await fireEvent.click(screen.getByRole("button", { name: /X.*Manage connection/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Disconnect X" }));

    await waitFor(() => expect(onDisconnectSource).toHaveBeenCalledWith("source-x"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "X source disconnected.",
    );
  });

  it("describes X sign-in with channel-neutral dedicated-browser guidance", () => {
    renderConnections(() => Promise.resolve(disconnectResponse));

    fireEvent.click(screen.getByRole("button", { name: /X.*Manage connection/ }));
    expect(
      screen.getByText(
        "Sign in through Morning Post's dedicated browser profile, then discover or add safe X targets.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/dedicated Chrome profile/)).toBeNull();
  });

  it("routes a disconnect authentication error to auth recovery", async () => {
    const onDisconnectSource = vi.fn(() =>
      Promise.reject(new ApiClientError(401, "UNAUTHENTICATED", "Sign in again.")),
    );
    const onAuthError = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderConnections(onDisconnectSource, onAuthError);

    await fireEvent.click(screen.getByRole("button", { name: /X.*Manage connection/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Disconnect X" }));

    await waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
