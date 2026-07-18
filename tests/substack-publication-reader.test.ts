import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  readPublicArchive,
  normalizePublicationUrl,
  readBoundedResponse,
  isDnsNotFoundError,
  validateArchivePage,
} from "../src/connectors/substack/publication-reader.ts";

const archivePage = [
  {
    id: 101,
    publication_id: 9,
    type: "newsletter",
    title: "Paid preview",
    post_date: "2026-07-16T09:00:00.000Z",
    audience: "only_paid",
    truncated_body_text: "A short preview",
    canonical_url: "https://example.substack.com/p/paid-preview",
    publishedBylines: [{
      name: "Example",
      publicationUsers: [{ publication: { id: 9, name: "Example Letter" } }],
    }],
  },
];

function responseFrom(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("normalizePublicationUrl canonicalizes publication inputs", () => {
  assertEquals(
    normalizePublicationUrl("https://example.substack.com/p/hello?x=1#part"),
    "https://example.substack.com",
  );
  assertEquals(
    normalizePublicationUrl("example.substack.com/feed"),
    "https://example.substack.com",
  );
  assertThrows(() => normalizePublicationUrl("http://example.com"));
  assertThrows(() => normalizePublicationUrl("https://user:pass@example.com"));
  assertThrows(() => normalizePublicationUrl("https://example.com:8443"));
  assertThrows(() => normalizePublicationUrl("https://2130706433"));
  assertThrows(() => normalizePublicationUrl("https://0x7f000001"));
  assertThrows(() => normalizePublicationUrl("https://[::ffff:127.0.0.1]"));
  assertThrows(() => normalizePublicationUrl(`https://example.com/${"x".repeat(2049)}`));
});

Deno.test("validateArchivePage requires every archive member to be valid", () => {
  assertEquals(validateArchivePage(JSON.stringify(archivePage))[0].publicationName, "Example Letter");
  assertThrows(() => validateArchivePage(JSON.stringify([{ ...archivePage[0], publication_id: undefined }])));
  assertThrows(() => validateArchivePage(JSON.stringify([{}])));
  assertThrows(() => validateArchivePage("{}"));
});

Deno.test("DNS NotFound errors are treated as an absent address family", () => {
  assertEquals(isDnsNotFoundError(new Deno.errors.NotFound("No records found")), true);
  assertEquals(isDnsNotFoundError(new Error("resolver failed")), false);
});

Deno.test("readBoundedResponse enforces exact limits and cancels overflow", async () => {
  const exact = await readBoundedResponse(
    new Response(new Uint8Array(5 * 1024 * 1024)),
    5 * 1024 * 1024,
  );
  assertEquals(exact.byteLength, 5 * 1024 * 1024);

  let cancelled = false;
  const overflow = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assertRejects(
    () => readBoundedResponse(new Response(overflow), 1),
    Error,
    "response exceeds byte limit",
  );
  assertEquals(cancelled, true);
});

Deno.test("readBoundedResponse cancels a pending body on abort", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const reading = readBoundedResponse(new Response(stalled), 100, controller.signal);
  controller.abort(new Error("reader aborted"));
  await assertRejects(() => reading, Error, "reader aborted");
  assertEquals(cancelled, true);
});

Deno.test("readPublicArchive resolves A and AAAA independently", async () => {
  const recordTypes: string[] = [];
  const requests: Request[] = [];
  const result = await readPublicArchive("https://example.substack.com/feed", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(responseFrom(JSON.stringify(archivePage)));
    },
    resolveDns: (_host: string, recordType: "A" | "AAAA") => {
      recordTypes.push(recordType);
      return Promise.resolve(recordType === "A" ? ["93.184.216.34"] : []);
    },
  });
  assertEquals(recordTypes.sort(), ["A", "AAAA"]);
  assertEquals(result.origin, "https://example.substack.com");
  assertEquals(result.items[0].id, 101);
  assertEquals(requests[0].url, "https://example.substack.com/api/v1/archive?sort=new&search=&offset=0&limit=50");
  assertEquals(requests[0].headers.get("cookie"), null);
  assertEquals(requests[0].headers.get("authorization"), null);
});

Deno.test("readPublicArchive passes validated addresses to the pinned transport", async () => {
  const requests: Array<{ url: string; addresses: string[] }> = [];
  const result = await readPublicArchive("https://letter.example.com", {
    resolveDns: (_host, recordType) => Promise.resolve(
      recordType === "A" ? ["93.184.216.34"] : ["2001:4860:4860::8888"],
    ),
    pinnedRequest: (url, addresses) => {
      requests.push({ url: url.toString(), addresses });
      return Promise.resolve(responseFrom(JSON.stringify(archivePage)));
    },
  });
  assertEquals(result.items.length, 1);
  assertEquals(requests, [{
    url: "https://letter.example.com/api/v1/archive?sort=new&search=&offset=0&limit=50",
    addresses: ["93.184.216.34", "2001:4860:4860::8888"],
  }]);
});

Deno.test("readPublicArchive rejects missing, mixed, and failed DNS answers", async () => {
  const fetcher = () => Promise.resolve(responseFrom(JSON.stringify(archivePage)));
  await assertRejects(
    () => readPublicArchive("https://example.com", {
      fetch: fetcher,
      resolveDns: () => Promise.resolve([]),
    }),
    Error,
    "public addresses",
  );
  await assertRejects(
    () => readPublicArchive("https://example.com", {
      fetch: fetcher,
      resolveDns: (_host, recordType) => Promise.resolve(
        recordType === "A" ? ["93.184.216.34"] : ["::1"],
      ),
    }),
    Error,
    "public addresses",
  );
  await assertRejects(
    () => readPublicArchive("https://example.com", {
      fetch: fetcher,
      resolveDns: (_host, recordType) => recordType === "A"
        ? Promise.resolve(["93.184.216.34"])
        : Promise.reject(new Error("resolver failed")),
    }),
    Error,
    "resolver failed",
  );
});

Deno.test("readPublicArchive revalidates redirect hosts without credentials", async () => {
  const hosts: string[] = [];
  const requests: Request[] = [];
  const result = await readPublicArchive("https://example.substack.com/p/post", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(requests.length === 1
        ? new Response(null, {
          status: 302,
          headers: { location: "https://newsletter.example.com/unsafe?cookie=steal" },
        })
        : responseFrom(JSON.stringify(archivePage)));
    },
    resolveDns: (host) => {
      hosts.push(host);
      return Promise.resolve(["93.184.216.34"]);
    },
  });
  assertEquals(hosts, [
    "example.substack.com",
    "example.substack.com",
    "newsletter.example.com",
    "newsletter.example.com",
  ]);
  assertEquals(result.origin, "https://newsletter.example.com");
  assertEquals(requests[1].url, "https://newsletter.example.com/api/v1/archive?sort=new&search=&offset=0&limit=50");
  assertEquals(requests[1].headers.get("cookie"), null);
});

Deno.test("readPublicArchive rejects private redirect destinations before fetching them", async () => {
  let fetchCount = 0;
  await assertRejects(
    () => readPublicArchive("https://example.substack.com", {
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { location: "https://internal.example/feed" },
        }));
      },
      resolveDns: (host) => Promise.resolve(
        host === "internal.example" ? ["127.0.0.1"] : ["93.184.216.34"],
      ),
    }),
    Error,
    "public addresses",
  );
  assertEquals(fetchCount, 1);
});

Deno.test("readPublicArchive rejects missing locations and too many redirects", async () => {
  const resolveDns = () => Promise.resolve(["93.184.216.34"]);
  await assertRejects(
    () => readPublicArchive("https://example.substack.com", {
      fetch: () => Promise.resolve(new Response(null, { status: 302 })),
      resolveDns,
    }),
    Error,
    "no location",
  );

  let redirect = 0;
  await assertRejects(
    () => readPublicArchive("https://example.substack.com", {
      fetch: () => Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: `https://redirect-${redirect += 1}.example/feed` },
      })),
      resolveDns,
    }),
    Error,
    "redirect limit",
  );
});
