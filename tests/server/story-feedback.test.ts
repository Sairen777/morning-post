import { test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { assertEquals, assertExists } from "../assertions.ts";
import type { Database } from "../../src/db/client.ts";
import { digests } from "../../src/db/schema/digest.ts";
import { digestStories, stories } from "../../src/db/schema/story.ts";
import { users } from "../../src/db/schema/user.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { buildApp, type ServerEnvironment } from "../../src/server/app.ts";

const ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "analytical-engine-1843";

function request(body: unknown, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function session(app: Hono<ServerEnvironment>, email: string): Promise<string> {
  assertEquals((await app.request("/auth/register", request({
    name: "Feedback User",
    email,
    password: PASSWORD,
  }))).status, 201);
  const login = await app.request("/auth/login", request({ email, password: PASSWORD }));
  assertEquals(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assertExists(setCookie);
  return setCookie.split(";")[0];
}

async function deliveredStory(database: Database, email: string) {
  const [user] = await database.select().from(users).where(eq(users.email, email));
  const [story] = await database.insert(stories).values({
    userId: user.id,
    canonicalKey: `server-${email}`,
    title: "Server feedback",
    topics: ["Climate"],
    entities: ["Example Corp"],
    version: 4,
    firstSeenAt: 1,
    lastUpdatedAt: 2,
  }).returning();
  const [digest] = await database.insert(digests).values({
    userId: user.id,
    periodStartMs: 1,
    periodEndMs: 2,
    status: "complete",
    contentMode: "stories",
    createdAt: 1,
    updatedAt: 1,
  }).returning();
  const [delivered] = await database.insert(digestStories).values({
    digestId: digest.id,
    storyId: story.id,
    storyVersion: 4,
    profileVersion: 1,
    title: story.title,
    topics: ["Climate"],
    entities: ["Example Corp"],
    points: [],
    sources: [],
    relevanceScore: 80,
    matchedInterestRuleIds: [],
    generatedAt: 3,
  }).returning();
  return { story, delivered };
}

test("POST story feedback requires ownership and returns public feedback with current rules", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const ownerCookie = await session(app, "feedback-route-owner@example.com");
    const strangerCookie = await session(app, "feedback-route-stranger@example.com");
    const fixture = await deliveredStory(database, "feedback-route-owner@example.com");
    const path = `/stories/${fixture.story.id}/feedback`;
    const body = {
      digestStoryId: fixture.delivered.id,
      action: "follow_topic",
      target: { kind: "topic", label: "Climate" },
    };

    assertEquals((await app.request(path, request(body))).status, 401);
    assertEquals((await app.request(path, request(body, strangerCookie))).status, 404);

    const response = await app.request(path, request(body, ownerCookie));
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.feedback.storyVersion, 4);
    assertEquals(result.feedback.target, { kind: "topic", label: "Climate" });
    assertEquals(result.feedback.userId, undefined);
    assertEquals(result.interestRules.map((rule: Record<string, unknown>) => [
      rule.label,
      rule.disposition,
      rule.origin,
    ]), [["Climate", "prioritize", "explicit"]]);
  });
});

test("POST story feedback validates action target shape and delivered target membership", async () => {
  await withTestDb(async (database) => {
    const app = buildApp(database);
    const cookie = await session(app, "feedback-route-validation@example.com");
    const fixture = await deliveredStory(database, "feedback-route-validation@example.com");
    const path = `/stories/${fixture.story.id}/feedback`;

    assertEquals((await app.request(path, request({
      digestStoryId: fixture.delivered.id,
      action: "relevant",
      target: { kind: "topic", label: "Climate" },
    }, cookie))).status, 422);
    assertEquals((await app.request(path, request({
      digestStoryId: fixture.delivered.id,
      action: "show_less_topic",
      target: { kind: "topic", label: "Invented" },
    }, cookie))).status, 422);
  });
});
