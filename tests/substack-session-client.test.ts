import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  SubstackSessionClient,
  validateSessionCookieValue,
} from "../src/connectors/substack/session-client.ts";

const credentials = { substackSessionId: "s%3Aprimary.signature" };

Deno.test("session client validates a session without leaking credentials", async () => {
  const requests: Request[] = [];
  const client = new SubstackSessionClient(credentials, (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(new Response(JSON.stringify({ user_id: 42 })));
  });
  assertEquals(await client.validateSession(), { userId: 42 });
  assertEquals(requests[0].url, "https://substack.com/api/v1/user-settings");
  assertEquals(requests[0].redirect, "manual");
  assertEquals(requests[0].headers.get("cookie"), "substack.sid=s%3Aprimary.signature");
});

Deno.test("session client sends the optional compatibility cookie only to substack.com", async () => {
  const requests: Request[] = [];
  const client = new SubstackSessionClient({
    ...credentials,
    connectSessionId: "s%3Acompat.signature",
  }, (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(JSON.stringify({
      post: {
        id: 7,
        publication_id: 9,
        body_html: "<p>Full body</p>",
      },
    })));
  });
  const post = await client.getPostById(7);
  assertEquals(post?.bodyHtml, "<p>Full body</p>");
  assertEquals(requests[0].url, "https://substack.com/api/v1/posts/by-id/7");
  assertEquals(
    requests[0].headers.get("cookie"),
    "substack.sid=s%3Aprimary.signature; connect.sid=s%3Acompat.signature",
  );
});

Deno.test("session client rejects redirects and expired sessions safely", async () => {
  const secret = "s%3Asecret.signature";
  const redirected = new SubstackSessionClient({ substackSessionId: secret }, () =>
    Promise.resolve(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/steal" },
    }))
  );
  await assertRejects(() => redirected.validateSession(), Error, "unexpected redirect");

  const expired = new SubstackSessionClient({ substackSessionId: secret }, () =>
    Promise.resolve(new Response("private upstream body", { status: 401 }))
  );
  const error = await assertRejects(
    () => expired.validateSession(),
    Error,
    "Substack session expired; reconnect required",
  );
  assertEquals(error.message.includes(secret), false);
  assertEquals(error.message.includes("private upstream body"), false);
});

Deno.test("session client maps unavailable posts to null", async () => {
  for (const status of [403, 404]) {
    const client = new SubstackSessionClient(credentials, () =>
      Promise.resolve(new Response(null, { status }))
    );
    assertEquals(await client.getPostById(7), null);
  }
});

Deno.test("session client rejects malformed credentials and responses", async () => {
  for (const value of ["", "space value", "quoted\"value", "semi;colon", "line\nbreak", "x".repeat(4097)]) {
    assertThrows(() => validateSessionCookieValue(value));
  }
  assertEquals(validateSessionCookieValue("s%3Avalid.signature"), "s%3Avalid.signature");
  const client = new SubstackSessionClient(credentials, () =>
    Promise.resolve(new Response(JSON.stringify({ post: { id: "7" } })))
  );
  await assertRejects(() => client.getPostById(7), Error, "invalid response");
  await assertRejects(() => client.getPostById(0), Error, "positive integer");
});
