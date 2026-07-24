import { expect, test } from "@playwright/test";
import type {
  PublicDigest,
  PublicSource,
  PublicUser,
} from "../src/api/types";

const user = {
  id: "user-mixed-digest",
  name: "Mixed digest reader",
  email: "mixed-digest@example.com",
  systemPrompt: "Summarize clearly",
  summaryPrompt: "Summarize clearly",
  defaultLanguage: "en",
  defaultRelevanceFilterMode: "personalized",
  relevanceThreshold: 0.5,
  maximumStoriesPerDigest: null,
  interestProfileVersion: 0,
  createdAt: 1_704_067_200_000,
  updatedAt: 1_704_067_200_000,
} satisfies PublicUser;

const digest = {
  id: "mixed-digest",
  userId: user.id,
  periodStartMs: 1_704_067_200_000,
  periodEndMs: 1_704_153_600_000,
  status: "complete",
  createdAt: 1_704_153_600_000,
  updatedAt: 1_704_153_600_000,
} satisfies PublicDigest;

const sources = [
  {
    id: "telegram-source",
    userId: user.id,
    connectorId: "Telegram",
    position: 0,
    enabled: true,
    showPaidPostTitles: false,
    relevanceFilterMode: "inherit",
    connected: true,
    createdAt: 1_704_067_200_000,
    updatedAt: 1_704_067_200_000,
  },
  {
    id: "substack-source",
    userId: user.id,
    connectorId: "Substack",
    position: 1,
    enabled: true,
    showPaidPostTitles: true,
    relevanceFilterMode: "inherit",
    connected: true,
    createdAt: 1_704_067_200_000,
    updatedAt: 1_704_067_200_000,
  },
] satisfies PublicSource[];

const mixedDigestView = {
  digest,
  sections: [],
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
                text: "Telegram point stays in the flat feed list",
                sourceUrl: null,
              },
            ],
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
                sourceUrl: "https://example.com/second",
                publishedAt: 1_704_153_600_000,
                contentAccess: "full",
                points: [
                  { text: "Second article point", sourceUrl: null },
                ],
              },
            ],
          },
        },
        {
          sourceId: "substack-source",
          connectorId: "Substack",
          feedId: "empty-substack-feed",
          feedName: "Empty Substack publication",
          feedRemoved: false,
          content: {
            kind: "articles",
            articles: [],
          },
        },
      ],
    },
  ],
  paidPosts: [
    {
      newsletterName: "The Dispatch Review",
      title: "Subscriber-only dispatch",
      sourceUrl: "https://example.com/paid-dispatch",
      publishedAt: 1_704_153_600_000,
      preview: "Paid post preview must not render",
      body: "Paid post body must not render",
    },
    {
      newsletterName: "The Dispatch Review",
      title: "Second subscriber-only dispatch",
      sourceUrl: "javascript:alert(document.domain)",
      publishedAt: 1_704_196_800_000,
      preview: "Second paid preview must not render",
      body: "Second paid body must not render",
    },
  ],
};

test("renders mixed digest content without crossing article boundaries", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/me") {
      await route.fulfill({ json: user });
      return;
    }
    if (url.pathname === "/sources") {
      await route.fulfill({ json: sources });
      return;
    }
    if (url.pathname === "/feeds") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/interests" && route.request().method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/digests" && route.request().method() === "GET") {
      await route.fulfill({ json: { data: [digest], nextCursor: null } });
      return;
    }
    if (url.pathname === "/digests/runs") {
      await route.fulfill({ json: { data: [], nextCursor: null } });
      return;
    }
    if (url.pathname === "/digests/mixed-digest") {
      await route.fulfill({ json: mixedDigestView });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Digests" })).toBeVisible();
  await page.getByRole("button", { name: /#1/ }).click();
  await expect(page.getByRole("heading", { name: "First article" }))
    .toBeVisible();

  const firstArticle = page.locator("article").filter({
    hasText: "First article",
  });
  const secondArticle = page.locator("article").filter({
    hasText: "Second article",
  });
  await expect(firstArticle.locator("li")).toContainText("First article point");
  await expect(firstArticle.locator("li")).not.toContainText(
    "Second article point",
  );
  await expect(secondArticle.locator("li")).toContainText(
    "Second article point",
  );
  await expect(secondArticle.locator("li")).not.toContainText(
    "First article point",
  );
  await expect(firstArticle.getByRole("link", { name: "source" })).toHaveCount(
    0,
  );
  await expect(page.getByText("No articles available.")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Empty Substack publication" }),
  ).toHaveCount(0);

  const telegramSection = page.locator("section.digest-section").filter({
    hasText: "Telegram channel",
  });
  await expect(telegramSection.locator("article")).toHaveCount(0);
  await expect(telegramSection.locator("li")).toContainText(
    "Telegram point stays in the flat feed list",
  );

  const paidPosts = page.locator("section.paid-posts");
  const paidHeadings = paidPosts.locator("h4");
  await expect(paidHeadings).toHaveCount(1);
  await expect(paidHeadings).toHaveText("The Dispatch Review");
  const newsletterHeadingId = await paidHeadings.getAttribute("id");
  expect(newsletterHeadingId).toBeTruthy();
  const newsletterList = paidPosts.locator("ul.paid-post-list");
  await expect(newsletterList).toHaveCount(1);
  await expect(newsletterList).toHaveAttribute(
    "aria-labelledby",
    newsletterHeadingId!,
  );
  await expect(newsletterList.locator("li")).toHaveText([
    "Subscriber-only dispatch",
    "Second subscriber-only dispatch",
  ]);
  const paidPostLink = paidPosts.getByRole("link", {
    name: "Subscriber-only dispatch",
  });
  await expect(paidPostLink).toHaveAttribute(
    "href",
    "https://example.com/paid-dispatch",
  );
  await expect(newsletterList.locator("a")).toHaveCount(1);
  await expect(
    paidPosts.getByRole("link", { name: "Second subscriber-only dispatch" }),
  ).toHaveCount(0);
  await expect(
    paidPosts.getByRole("link", { name: "The Dispatch Review" }),
  ).toHaveCount(0);
  await expect(paidPosts.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(paidPosts).not.toContainText(
    "Paid post preview must not render",
  );
  await expect(paidPosts).not.toContainText("Paid post body must not render");
  await expect(paidPosts).not.toContainText(
    "Second paid preview must not render",
  );
  await expect(paidPosts).not.toContainText("Second paid body must not render");
  await expect(
    page.locator("section.digest-section, section.paid-posts").last(),
  ).toHaveClass(/paid-posts/);
});
