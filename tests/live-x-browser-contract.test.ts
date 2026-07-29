import { test } from "bun:test";
import type { NormalizedData } from "../src/connectors/connector.types.ts";
import { assert, assertEquals, assertExists } from "./assertions.ts";

const liveXBrowserContract = test.skipIf(
  process.env["LIVE_X_BROWSER_CONTRACT"] !== "1",
);
const DAY_MS = 24 * 60 * 60 * 1_000;

liveXBrowserContract(
  "managed Chromium resolves and collects the configured X target",
  async () => {
    const { profileId, targetUrl } = requireLiveConfiguration();
    const [
      { getXBrowserConfig },
      {
        formatXFeedExternalId,
        formatXTargetUrl,
        parseXTargetUrl,
        XBrowserRuntime,
      },
      { ConnectorId },
    ] = await Promise.all([
      import("../src/config.ts"),
      import("../src/connectors/x/index.ts"),
      import("../src/constants.ts"),
    ]);

    const target = parseXTargetUrl(targetUrl);
    assertEquals(
      formatXTargetUrl(target),
      targetUrl,
      "X_BROWSER_LIVE_TARGET_URL must be canonical",
    );
    const canonicalFeedId = formatXFeedExternalId(target);
    const browserConfig = getXBrowserConfig();
    const runtime = new XBrowserRuntime({
      profileRoot: browserConfig.profileRoot,
      browserChannel: browserConfig.browserChannel,
    });

    const resolvedFeed = await runtime.resolveTarget(profileId, targetUrl);
    assertEquals(
      resolvedFeed.externalId,
      canonicalFeedId,
      "resolved X feed identity must match the canonical target",
    );

    const connector = runtime.createConnector(profileId);
    const to = Date.now();
    const from = to - DAY_MS;
    let collected: NormalizedData;
    try {
      collected = await connector.getNormalizedData(from, to, [canonicalFeedId]);
    } finally {
      await connector.dispose();
    }

    assertEquals(
      Object.keys(collected),
      [canonicalFeedId],
      "X collection must return only the requested canonical feed",
    );
    const items = collected[canonicalFeedId];
    assertExists(items, "X collection omitted the requested canonical feed");
    assert(
      items.length > 0,
      "Live X target returned no items from the preceding 24 hours; configure an active target",
    );

    for (const item of items) {
      assertEquals(item.connectorId, ConnectorId.X);
      assertEquals(
        item.feedExternalId,
        canonicalFeedId,
        "collected item must retain the canonical X feed identity",
      );
      assert(
        Number.isFinite(item.date) && item.date >= from && item.date <= to,
        "collected X item date must be inside the requested preceding 24-hour window",
      );
      assert(
        item.text.trim().length > 0,
        "collected X items must contain non-empty text",
      );

      if (target.kind === "chat") {
        assertChatReactionMetadata(item.meta);
      }
    }
  },
  600_000,
);

function requireLiveConfiguration(): { profileId: string; targetUrl: string } {
  const profileId = process.env["X_BROWSER_LIVE_PROFILE_ID"]?.trim();
  const targetUrl = process.env["X_BROWSER_LIVE_TARGET_URL"]?.trim();
  if (!profileId || !targetUrl) {
    const missing = [
      ...(profileId ? [] : ["X_BROWSER_LIVE_PROFILE_ID"]),
      ...(targetUrl ? [] : ["X_BROWSER_LIVE_TARGET_URL"]),
    ];
    throw new Error(
      `Live X browser contract is missing required configuration: ${missing.join(", ")}. ` +
        "Set a connected profile UUID and one canonical X home, List, or Chat target URL.",
    );
  }
  return { profileId, targetUrl };
}

function assertChatReactionMetadata(
  meta: Record<string, unknown> | undefined,
): void {
  assertExists(meta, "normalized X Chat item must contain metadata");
  assertEquals(meta["messageKind"], "chat");
  const reactions = meta["reactions"];
  assert(Array.isArray(reactions), "X Chat reactions metadata must be an array");

  let reactionCount = 0;
  let reactedByViewer = false;
  for (const reaction of reactions) {
    assert(
      typeof reaction === "object" && reaction !== null,
      "X Chat reaction metadata entries must be objects",
    );
    const value = reaction as Record<string, unknown>;
    assert(
      typeof value["emoji"] === "string" && value["emoji"].trim().length > 0,
      "X Chat reaction emoji must be a non-empty string",
    );
    assert(
      Number.isInteger(value["count"]) && (value["count"] as number) > 0,
      "X Chat reaction count must be a positive integer",
    );
    assert(
      typeof value["reactedByViewer"] === "boolean",
      "X Chat reactedByViewer must be boolean",
    );
    reactionCount += value["count"] as number;
    reactedByViewer ||= value["reactedByViewer"] as boolean;
  }

  assertEquals(meta["reactionCount"], reactionCount);
  assertEquals(meta["reactedByViewer"], reactedByViewer);
}
