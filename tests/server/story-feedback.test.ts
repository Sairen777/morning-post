import { test } from "bun:test";
import type { Hono } from "hono";
import { assertEquals, assertExists } from "../assertions.ts";
import type { Database } from "../../src/db/client.ts";
import { digests } from "../../src/db/schema/digest.ts";
import { digestStories, stories } from "../../src/db/schema/story.ts";
import { withTestDb } from "../../src/db/testing.ts";
import { buildApp, type ServerEnvironment } from "../../src/server/app.ts";
import { createUser } from "../../src/repositories/user-repository.ts";
import { createSession } from "../../src/auth/session-service.ts";

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

async function ownerSession(app: Hono<ServerEnvironment>): Promise<{ userId: string; cookie: string }> {
  const setup = await app.request("/auth/setup", request({
    name: "Feedback User",
  }));
  assertEquals(setup.status, 201);
  const user = await setup.json();
  const loginResp = await app.request("/auth/login", request({ password: PASSWORD }));
  assertEquals(loginResp.status, 200);
  const setCookie = loginResp.headers.get("set-cookie");
  assertExists(setCookie);
  return { userId: user.id, cookie: setCookie.split(";")[0] };
}

async function strangerSession(database: Database, sessionEmail: string): Promise<string> {
  const stranger = await createUser(database, {
    name: "Stranger",
    email: sessionEmail,
    passwordHash: "$argon2id$fakehash",
    systemPrompt: "Summarize tersely.",
  });
  const { token } = await createSession(database, stranger.id);
  return `__Host-session=${token}`;
}

async function deliveredStory(database: Database, userId: string) {
  const [story] = await database.insert(stories).values({
    userId,
    canonicalKey: `server-${userId}`,
    title: "Server feedback",
    topics: ["Climate"],
    entities: ["Example Corp"],
    version: 4,
    firstSeenAt: 1,
    lastUpdatedAt: 2,
  }).returning();
  const [digest] = await database.insert(digests).values({
    userId,
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
    const { userId: ownerId, cookie: ownerCookie } = await ownerSession(app);
    const strangerCookie = await strangerSession(database, "feedback-route-stranger@example.com");
    const fixture = await deliveredStory(database, ownerId);
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
    const { userId, cookie } = await ownerSession(app);
    const fixture = await deliveredStory(database, userId);
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
