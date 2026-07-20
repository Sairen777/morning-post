import { assertEquals, assertRejects } from "@std/assert";
import { ConnectorId } from "../src/constants.ts";
import {
  type PublicationPageReader,
  SubstackConnector,
  type SubstackPostReader,
} from "../src/connectors/substack/substack-connector.ts";
import type { ArchiveItem } from "../src/connectors/substack/publication-reader.ts";
import type { SubstackPrivatePost } from "../src/connectors/substack/session-client.ts";

const FROM = 1_700_000_000_000;
const TO = 1_700_100_000_000;
const PUBLICATION = "https://example.substack.com";

function archiveItem(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: 101,
    type: "newsletter",
    title: "Paid article",
    postDate: FROM + 1_000,
    audience: "only_paid",
    truncatedBodyText: "Public preview",
    description: "Description",
    subtitle: "Subtitle",
    canonicalUrl: `${PUBLICATION}/p/paid-article`,
    publishedBylines: [{ name: "Author Name" }],
    publicationName: "Example Letter",
    publicationId: 9,
    raw: {},
    ...overrides,
  };
}

function post(
  overrides: Partial<SubstackPrivatePost> = {},
): SubstackPrivatePost {
  return {
    id: 101,
    publicationId: 9,
    bodyHtml:
      '<p>Full <a href="https://tracking.example">body</a>.</p><script>secret()</script>',
    hasPaidSubscription: true,
    ...overrides,
  };
}

Deno.test("SubstackConnector normalizes authenticated full posts under the requested feed key", async () => {
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: "https://custom.example.com",
      items: offset === 0 ? [archiveItem()] : [],
    });
  const posts: SubstackPostReader = {
    getPostById: () => Promise.resolve(post()),
  };
  const connector = new SubstackConnector(posts, pages);
  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);
  assertEquals(Object.keys(result), [PUBLICATION]);
  assertEquals(result[PUBLICATION], [{
    connectorId: ConnectorId.Substack,
    feedExternalId: PUBLICATION,
    externalId: "101",
    date: FROM + 1_000,
    title: "Paid article",
    text: "Full body.",
    author: "Author Name",
    url: `${PUBLICATION}/p/paid-article`,
    meta: {
      audience: "only_paid",
      contentAccess: "full",
      hasPaidSubscription: true,
    },
  }]);
});

Deno.test("SubstackConnector does not classify a free signup paid-post teaser as full", async () => {
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0 ? [archiveItem()] : [],
    });
  const teaser = Object.assign(post({ bodyHtml: "<p>Subscriber teaser</p>" }), {
    hasPaidSubscription: false,
  });
  const connector = new SubstackConnector(
    { getPostById: () => Promise.resolve(teaser) },
    pages,
  );

  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);

  assertEquals(result[PUBLICATION][0].text, "Public preview");
  assertEquals(result[PUBLICATION][0].meta, {
    audience: "only_paid",
    contentAccess: "preview",
    hasPaidSubscription: false,
  });
});

Deno.test("SubstackConnector rejects an empty body for an accessible paid post", async () => {
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0 ? [archiveItem()] : [],
    });
  const connector = new SubstackConnector(
    {
      getPostById: () => Promise.resolve(post({ bodyHtml: null })),
    },
    pages,
  );

  await assertRejects(
    () => connector.getNormalizedData(FROM, TO, [PUBLICATION]),
    Error,
    "empty body for an accessible paid post",
  );
});

Deno.test("SubstackConnector preserves private bodies for non-paid posts without paid entitlement", async () => {
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0 ? [archiveItem({ audience: "everyone" })] : [],
    });
  const connector = new SubstackConnector(
    {
      getPostById: () => Promise.resolve(post({ hasPaidSubscription: false })),
    },
    pages,
  );

  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);

  assertEquals(result[PUBLICATION][0].text, "Full body.");
  assertEquals(result[PUBLICATION][0].meta, {
    audience: "everyone",
    contentAccess: "full",
    hasPaidSubscription: false,
  });
});

Deno.test("SubstackConnector normalizes public podcasts alongside paid newsletter previews", async () => {
  const podcast = archiveItem({
    id: 201,
    type: "podcast",
    title: "Public podcast",
    postDate: FROM + 2_000,
    audience: "everyone",
    truncatedBodyText: "Podcast preview",
    canonicalUrl: `${PUBLICATION}/p/public-podcast`,
    publicationId: 19,
  });
  const paidNewsletter = archiveItem({
    id: 202,
    title: "Paid newsletter",
    postDate: FROM + 1_000,
    canonicalUrl: `${PUBLICATION}/p/paid-newsletter`,
    publicationId: 19,
  });
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0 ? [podcast, paidNewsletter] : [],
    });
  const privatePosts = new Map<number, SubstackPrivatePost>([
    [
      podcast.id,
      post({
        id: podcast.id,
        publicationId: podcast.publicationId,
        bodyHtml: "<p>Complete podcast body.</p>",
        hasPaidSubscription: false,
      }),
    ],
    [
      paidNewsletter.id,
      post({
        id: paidNewsletter.id,
        publicationId: paidNewsletter.publicationId,
        bodyHtml: "<p>Private paid body.</p>",
        hasPaidSubscription: false,
      }),
    ],
  ]);
  const posts: SubstackPostReader = {
    getPostById: (id) => Promise.resolve(privatePosts.get(id) ?? null),
  };
  const connector = new SubstackConnector(posts, pages);

  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);

  assertEquals(
    result[PUBLICATION].map((item) => item.externalId),
    ["201", "202"],
  );
  assertEquals(result[PUBLICATION], [{
    connectorId: ConnectorId.Substack,
    feedExternalId: PUBLICATION,
    externalId: "201",
    date: FROM + 2_000,
    title: "Public podcast",
    text: "Complete podcast body.",
    author: "Author Name",
    url: `${PUBLICATION}/p/public-podcast`,
    meta: {
      audience: "everyone",
      contentAccess: "full",
      hasPaidSubscription: false,
    },
  }, {
    connectorId: ConnectorId.Substack,
    feedExternalId: PUBLICATION,
    externalId: "202",
    date: FROM + 1_000,
    title: "Paid newsletter",
    text: "Public preview",
    author: "Author Name",
    url: `${PUBLICATION}/p/paid-newsletter`,
    meta: {
      audience: "only_paid",
      contentAccess: "preview",
      hasPaidSubscription: false,
    },
  }]);
});

Deno.test("SubstackConnector paginates until an entire page predates the window", async () => {
  const offsets: number[] = [];
  const pages: PublicationPageReader = (_publicationUrl, offset) => {
    offsets.push(offset);
    return Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0
        ? [archiveItem({ id: 101, postDate: FROM })]
        : [archiveItem({ id: 99, postDate: FROM - 1 })],
    });
  };
  const posts: SubstackPostReader = {
    getPostById: () => Promise.resolve(post()),
  };
  const connector = new SubstackConnector(posts, pages);
  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);
  assertEquals(offsets, [0, 1]);
  assertEquals(result[PUBLICATION].map((item) => item.externalId), ["101"]);
});

Deno.test("SubstackConnector uses preview fallbacks for unavailable bodies", async () => {
  const previews = [
    archiveItem({ id: 101, truncatedBodyText: "Preview text" }),
    archiveItem({
      id: 102,
      truncatedBodyText: undefined,
      description: "Description text",
    }),
    archiveItem({
      id: 103,
      truncatedBodyText: undefined,
      description: undefined,
      subtitle: "Subtitle text",
    }),
    archiveItem({
      id: 104,
      truncatedBodyText: undefined,
      description: undefined,
      subtitle: undefined,
      title: "Title text",
    }),
  ];
  const pages: PublicationPageReader = (_publicationUrl, offset) =>
    Promise.resolve({
      origin: PUBLICATION,
      items: offset === 0 ? previews : [],
    });
  const posts: SubstackPostReader = {
    getPostById: () => Promise.resolve(null),
  };
  const connector = new SubstackConnector(posts, pages);
  const result = await connector.getNormalizedData(FROM, TO, [PUBLICATION]);
  assertEquals(result[PUBLICATION].map((item) => item.text), [
    "Preview text",
    "Description text",
    "Subtitle text",
    "Title text",
  ]);
  assertEquals(
    result[PUBLICATION].every((item) => item.meta?.contentAccess === "preview"),
    true,
  );
});

Deno.test("SubstackConnector rejects mismatched private posts and repeated archive pages", async () => {
  const page = { origin: PUBLICATION, items: [archiveItem()] };
  const mismatch = new SubstackConnector(
    { getPostById: () => Promise.resolve(post({ publicationId: 10 })) },
    () => Promise.resolve(page),
  );
  await assertRejects(
    () => mismatch.getNormalizedData(FROM, TO, [PUBLICATION]),
    Error,
    "does not match archive preview",
  );

  const repeated = new SubstackConnector(
    { getPostById: () => Promise.resolve(post()) },
    () => Promise.resolve(page),
  );
  await assertRejects(
    () => repeated.getNormalizedData(FROM, TO, [PUBLICATION]),
    Error,
    "made no progress",
  );
});

Deno.test("SubstackConnector avoids work for an empty feed filter", async () => {
  let calls = 0;
  const connector = new SubstackConnector(
    {
      getPostById: () => {
        calls += 1;
        return Promise.resolve(post());
      },
    },
    () => {
      calls += 1;
      return Promise.resolve({ origin: PUBLICATION, items: [] });
    },
  );
  assertEquals(await connector.getNormalizedData(FROM, TO, []), {});
  assertEquals(calls, 0);
});
