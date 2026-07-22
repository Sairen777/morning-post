import { test } from "bun:test";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { assertEquals } from "./assertions.ts";
import { Api, type TelegramClient } from "telegram";
import { TelegramConnector, enforceMediaQuota } from "../src/connectors/telegram/telegram-connector.ts";
import { logTelegramClientError } from "../src/connectors/telegram/telegram-client.ts";
import { ConnectorId } from "../src/constants.ts";

// --- fakes ---
//
// We can't construct real Api.* TLObjects without satisfying the full
// generated TL schema (dozens of required booleans). Using
// Object.create(Class.prototype) gives us values that pass `instanceof`
// checks, then `Object.defineProperty` writes own fields that shadow the
// prototype's getter-only descriptors (plain Object.assign fails on them).

function applyFields<T extends object>(
  target: T,
  fields: Record<string, unknown>,
): T {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

function fakeApiMessage(fields: Partial<Api.Message> = {}): Api.Message {
  return applyFields(Object.create(Api.Message.prototype), {
    id: 1,
    date: 0,
    message: "",
    views: null,
    sender: undefined,
    media: undefined,
    groupedId: undefined,
    replyTo: undefined,
    ...fields,
  });
}

function fakeChannel(fields: Partial<Api.Channel> = {}): Api.Channel {
  return applyFields(Object.create(Api.Channel.prototype), {
    id: 1,
    title: "Channel",
    username: undefined,
    megagroup: false,
    ...fields,
  });
}

function fakeChat(fields: Partial<Api.Chat> = {}): Api.Chat {
  return applyFields(Object.create(Api.Chat.prototype), {
    id: 2,
    title: "Chat",
    ...fields,
  });
}

function fakeUser(fields: Partial<Api.User> = {}): Api.User {
  return applyFields(Object.create(Api.User.prototype), {
    id: 3,
    username: "user",
    firstName: "Direct",
    lastName: "User",
    ...fields,
  });
}

interface FakeDialog {
  title: string;
  entity: Api.Channel | Api.Chat | Api.User;
  messages: Api.Message[];
}

interface FakeClientData {
  dialogs?: FakeDialog[];
  quoted?: Map<number, Api.Message>;
}

function fakeTelegramClient(data: FakeClientData = {}): TelegramClient {
  const messagesByEntity = new Map<unknown, Api.Message[]>();
  for (const dialog of data.dialogs ?? []) {
    messagesByEntity.set(dialog.entity, dialog.messages);
  }

  const client = {
    async *iterDialogs() {
      for (const dialog of data.dialogs ?? []) {
        const latest = dialog.messages.length > 0
          ? dialog.messages.reduce((a, b) => (a.date > b.date ? a : b))
          : undefined;
        yield {
          title: dialog.title,
          entity: dialog.entity,
          message: latest,
        };
      }
    },
    async *iterMessages(
      entity: unknown,
      options: { offsetDate?: number } = {},
    ) {
      const messages = messagesByEntity.get(entity) ?? [];
      const offsetDate = options.offsetDate ?? Number.POSITIVE_INFINITY;
      const sorted = [...messages].sort((a, b) => b.date - a.date);
      for (const message of sorted) {
        if (message.date < offsetDate) yield message;
      }
    },
    getMessages(_entity: unknown, options: { ids: number[] }) {
      const quoted = data.quoted ?? new Map();
      return Promise.resolve(
        options.ids
          .map((id) => quoted.get(id))
          .filter((message): message is Api.Message => message !== undefined),
      );
    },
  };
  return client as unknown as TelegramClient;
}

// --- window ---
// All test messages live at IN_RANGE_S (unix seconds). FROM_MS and TO_MS
// bracket it in epoch-ms so they fit the connector's public boundary.
const IN_RANGE_S = 1_700_050_000;
const FROM_MS = 1_700_000_000_000;
const TO_MS = 1_700_100_000_000;

// --- tests ---

test("listAvailableFeeds — returns channel and group feed details", async () => {
  const channel = fakeChannel({ id: 10 as unknown as Api.Channel["id"], title: "Announcements" });
  const megagroup = fakeChannel({
    id: 11 as unknown as Api.Channel["id"],
    title: "Community",
    megagroup: true,
  });
  const chat = fakeChat({ id: 12 as unknown as Api.Chat["id"], title: "Legacy Chat" });
  const user = fakeUser({ id: 13 as unknown as Api.User["id"], firstName: "Direct", lastName: "Person" });
  const client = fakeTelegramClient({
    dialogs: [
      { title: "Announcements", entity: channel, messages: [] },
      { title: "Community", entity: megagroup, messages: [] },
      { title: "Legacy Chat", entity: chat, messages: [] },
      { title: "Direct Person", entity: user, messages: [] },
    ],
  });

  const result = await new TelegramConnector(client).listAvailableFeeds();

  assertEquals(result, [
    { externalId: "channel:10", name: "Announcements", kind: "news" },
    { externalId: "channel:11", name: "Community", kind: "discussion" },
    { externalId: "chat:12", name: "Legacy Chat", kind: "discussion" },
    { externalId: "user:13", name: "Direct Person", kind: "discussion" },
  ]);
});

test("listAvailableFeeds — falls back to entity id for missing dialog title", async () => {
  const channel = fakeChannel({ id: 42 as unknown as Api.Channel["id"], title: "Entity Title" });
  const client = fakeTelegramClient({
    dialogs: [{ title: "", entity: channel, messages: [] }],
  });

  const result = await new TelegramConnector(client).listAvailableFeeds();

  assertEquals(result, [
    { externalId: "channel:42", name: "42", kind: "news" },
  ]);
});

test("listAvailableFeeds — excluded dialog titles are skipped", async () => {
  const defaultChannel = fakeChannel({ title: "Telegram" });
  const subscribedChannel = fakeChannel({ id: 2 as unknown as Api.Channel["id"], title: "Subscribed" });
  const client = fakeTelegramClient({
    dialogs: [
      { title: "Telegram", entity: defaultChannel, messages: [] },
      { title: "Subscribed", entity: subscribedChannel, messages: [] },
    ],
  });

  const result = await new TelegramConnector(client).listAvailableFeeds();

  assertEquals(result, [
    { externalId: "channel:2", name: "Subscribed", kind: "news" },
  ]);
});

test("getNormalizedData — channel message becomes a NormalizedItem", async () => {
  const channel = fakeChannel({ title: "TestChannel", username: "test" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "hello world",
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [message] }],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(Object.keys(result), ["channel:1"]);
  assertEquals(result["channel:1"].length, 1);
  const item = result["channel:1"][0];
  assertEquals(item.text, "hello world");
  assertEquals(item.connectorId, ConnectorId.Telegram);
  assertEquals(item.feedExternalId, "channel:1");
  assertEquals(item.url, "https://t.me/test/1");
  assertEquals(item.date, IN_RANGE_S * 1000);
  assertEquals(item.meta, { isGroup: false });
});

test("getNormalizedData — excluded dialog titles are skipped", async () => {
  const channel = fakeChannel({ title: "Telegram" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "login code 123456",
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "Telegram", entity: channel, messages: [message] }],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(Object.keys(result), []);
});

test("getNormalizedData — feedExternalIds filter returns only selected feeds", async () => {
  const firstChannel = fakeChannel({ id: 1 as unknown as Api.Channel["id"], title: "First" });
  const secondChannel = fakeChannel({ id: 2 as unknown as Api.Channel["id"], title: "Second" });
  const client = fakeTelegramClient({
    dialogs: [
      { title: "First", entity: firstChannel, messages: [fakeApiMessage({ id: 1, date: IN_RANGE_S, message: "first" })] },
      { title: "Second", entity: secondChannel, messages: [fakeApiMessage({ id: 2, date: IN_RANGE_S, message: "second" })] },
    ],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
    ["channel:2", "channel:999"],
  );

  assertEquals(Object.keys(result), ["channel:2"]);
  assertEquals(result["channel:2"][0].text, "second");
});

test("getNormalizedData — empty feedExternalIds filter fetches nothing", async () => {
  const channel = fakeChannel({ title: "TestChannel" });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [fakeApiMessage({ date: IN_RANGE_S, message: "ignored" })] }],
  });

  const result = await new TelegramConnector(client).getNormalizedData(FROM_MS, TO_MS, []);

  assertEquals(result, {});
});

test("getNormalizedData — megagroup channel marks items as isGroup", async () => {
  const group = fakeChannel({ title: "MyGroup", megagroup: true });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "anyone here?",
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "MyGroup", entity: group, messages: [message] }],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(result["channel:1"][0].meta, { isGroup: true });
});

test("getNormalizedData — message without replyTo leaves text unchanged", async () => {
  const channel = fakeChannel({ title: "TestChannel" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "no reply",
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [message] }],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(result["channel:1"][0].text, "no reply");
});

test("getNormalizedData — replyTo without a matching quote leaves text unchanged", async () => {
  const channel = fakeChannel({ title: "TestChannel" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "reply",
    replyTo: { replyToMsgId: 99 } as unknown as Api.MessageReplyHeader,
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [message] }],
    // empty quoted map — id 99 not present
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(result["channel:1"][0].text, "reply");
});

test("getNormalizedData — matching quote is prepended to the message body", async () => {
  const channel = fakeChannel({ title: "TestChannel" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "my reply",
    replyTo: { replyToMsgId: 42 } as unknown as Api.MessageReplyHeader,
  });
  const quotedMessage = fakeApiMessage({ id: 42, message: "the original" });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [message] }],
    quoted: new Map([[42, quotedMessage]]),
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(
    result["channel:1"][0].text,
    "[QUOTED_MESSAGE]the original[/QUOTED_MESSAGE]\n\nmy reply",
  );
});

test("getNormalizedData — messages sharing a groupedId fold to one item", async () => {
  const channel = fakeChannel({ title: "TestChannel" });
  const groupedId = {
    toString: () => "g1",
  } as unknown as Api.Message["groupedId"];
  const captionMessage = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S + 1,
    message: "caption",
    groupedId,
  });
  const trailingMessage = fakeApiMessage({
    id: 2,
    date: IN_RANGE_S,
    message: "dropped during fold",
    groupedId,
  });
  const client = fakeTelegramClient({
    dialogs: [
      {
        title: "TestChannel",
        entity: channel,
        messages: [captionMessage, trailingMessage],
      },
    ],
  });

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
  );

  assertEquals(result["channel:1"].length, 1);
  assertEquals(result["channel:1"][0].text, "caption");
});

test("Telegram client operational errors redact provider secrets before logging", () => {
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const rawApiKey = "sk-telegram-secret";
    const rawPassword = "https://telegram-user:telegram-pass@example.com";
    logTelegramClientError(new Error(`provider failed with ${rawApiKey} at ${rawPassword}`));
    assertEquals(logged.length, 1);
    assertEquals(logged[0].includes(rawApiKey), false);
    assertEquals(logged[0].includes(rawPassword), false);
    assertEquals(logged[0].includes("[REDACTED]"), true);
  } finally {
    console.error = originalConsoleError;
  }
});

test("getNormalizedData — pre-aborted signal returns no data", async () => {
  const channel = fakeChannel({ title: "TestChannel", username: "test" });
  const message = fakeApiMessage({
    id: 1,
    date: IN_RANGE_S,
    message: "hello world",
  });
  const client = fakeTelegramClient({
    dialogs: [{ title: "TestChannel", entity: channel, messages: [message] }],
  });

  const controller = new AbortController();
  controller.abort();

  const result = await new TelegramConnector(client).getNormalizedData(
    FROM_MS,
    TO_MS,
    undefined,
    controller.signal,
  );

  assertEquals(Object.keys(result).length, 0);
});

test("enforceMediaQuota — deletes oldest files across subdirectories", async () => {
  const tmpDir = `./media/quota-test-${crypto.randomUUID()}`;
  try {
    await mkdir(`${tmpDir}/feed1`, { recursive: true });
    await mkdir(`${tmpDir}/feed2`, { recursive: true });

    const fileA = `${tmpDir}/feed1/oldest.txt`;
    const fileB = `${tmpDir}/feed2/mid.txt`;
    const fileC = `${tmpDir}/feed1/newest.txt`;
    await writeFile(fileA, new Uint8Array(100));
    await writeFile(fileB, new Uint8Array(100));
    await writeFile(fileC, new Uint8Array(100));
    // Set consistent mtimes so sorting is deterministic
    await utimes(fileA, 0, 1000);
    await utimes(fileB, 0, 2000);
    await utimes(fileC, 0, 3000);

    // 300 bytes used, quota 250, new file 50 bytes: need 350, must evict 100
    await enforceMediaQuota(tmpDir, 250, 50);

    const survivors: string[] = [];
    for (const dirEntry of await readdir(tmpDir + "/feed1", { withFileTypes: true })) {
      survivors.push(`feed1/${dirEntry.name}`);
    }
    for (const dirEntry of await readdir(tmpDir + "/feed2", { withFileTypes: true })) {
      survivors.push(`feed2/${dirEntry.name}`);
    }
    survivors.sort();

    assertEquals(survivors, ["feed1/newest.txt", "feed2/mid.txt"]);
  } finally {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  }
});
