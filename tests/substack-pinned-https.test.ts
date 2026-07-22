import { test } from "bun:test";
import { assertEquals, assertRejects } from "./assertions.ts";
import {
  requestPinnedHttps,
  type TransportConnection,
} from "../src/connectors/substack/pinned-https.ts";

class MemoryConnection implements TransportConnection {
  readonly writes: Uint8Array[] = [];
  closeCount = 0;
  private offset = 0;

  constructor(private readonly response: Uint8Array) {}

  read(buffer: Uint8Array): Promise<number | null> {
    if (this.offset >= this.response.length) return Promise.resolve(null);
    const length = Math.min(buffer.length, this.response.length - this.offset, 7);
    buffer.set(this.response.subarray(this.offset, this.offset + length));
    this.offset += length;
    return Promise.resolve(length);
  }

  write(buffer: Uint8Array): Promise<number> {
    const length = Math.min(buffer.length, 11);
    this.writes.push(buffer.slice(0, length));
    return Promise.resolve(length);
  }

  close(): void {
    this.closeCount++;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("requestPinnedHttps pins the validated IP while preserving Host and TLS SNI", async () => {
  const connection = new MemoryConnection(encoder.encode(
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]",
  ));
  const connectedAddresses: string[] = [];
  const tlsHostnames: string[] = [];
  const response = await requestPinnedHttps(
    new URL("https://letter.example.com/api/v1/archive?limit=50"),
    ["93.184.216.34"],
    undefined,
    {
      connect: (address) => {
        connectedAddresses.push(address);
        return Promise.resolve(connection);
      },
      startTls: (tcpConnection, hostname) => {
        assertEquals(tcpConnection, connection);
        tlsHostnames.push(hostname);
        return Promise.resolve(connection);
      },
    },
  );

  assertEquals(connectedAddresses, ["93.184.216.34"]);
  assertEquals(tlsHostnames, ["letter.example.com"]);
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "[]");
  const request = decoder.decode(Uint8Array.from(connection.writes.flatMap((chunk) => [...chunk])));
  assertEquals(request.includes("GET /api/v1/archive?limit=50 HTTP/1.1\r\n"), true);
  assertEquals(request.includes("Host: letter.example.com\r\n"), true);
  assertEquals(request.includes("Accept-Encoding: identity\r\n"), true);
});

test("requestPinnedHttps decodes bounded chunked responses", async () => {
  const connection = new MemoryConnection(encoder.encode(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n[{\r\n2\r\n}]\r\n0\r\nX-Trailer: ignored\r\n\r\n",
  ));
  const response = await requestPinnedHttps(
    new URL("https://letter.example.com/archive"),
    ["2001:4860:4860::8888"],
    undefined,
    {
      connect: () => Promise.resolve(connection),
      startTls: () => Promise.resolve(connection),
      maxResponseBytes: 4,
    },
  );
  assertEquals(await response.text(), "[{}]");
});

test("requestPinnedHttps rejects private addresses and oversized or encoded bodies", async () => {
  let connectCount = 0;
  await assertRejects(
    () => requestPinnedHttps(new URL("https://letter.example.com/archive"), ["127.0.0.1"], undefined, {
      connect: () => {
        connectCount += 1;
        return Promise.resolve(new MemoryConnection(new Uint8Array()));
      },
      startTls: (connection) => Promise.resolve(connection),
    }),
    Error,
    "public IP",
  );
  assertEquals(connectCount, 0);

  for (const responseText of [
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n12345",
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Encoding: gzip\r\n\r\nxx",
  ]) {
    const connection = new MemoryConnection(encoder.encode(responseText));
    await assertRejects(
      () => requestPinnedHttps(new URL("https://letter.example.com/archive"), ["93.184.216.34"], undefined, {
        connect: () => Promise.resolve(connection),
        startTls: () => Promise.resolve(connection),
        maxResponseBytes: 4,
      }),
      Error,
    );
  }
});

test("requestPinnedHttps closes the active transport when TLS setup fails", async () => {
  const connection = new MemoryConnection(new Uint8Array());
  await assertRejects(
    () =>
      requestPinnedHttps(
        new URL("https://letter.example.com/archive"),
        ["93.184.216.34"],
        undefined,
        {
          connect: () => Promise.resolve(connection),
          startTls: () => Promise.reject(new Error("TLS failed")),
        },
      ),
    Error,
    "could not connect",
  );
  assertEquals(connection.closeCount > 0, true);
});

test("requestPinnedHttps closes the active transport when TLS setup is aborted", async () => {
  const connection = new MemoryConnection(new Uint8Array());
  const controller = new AbortController();
  const abortReason = new Error("cancel pinned request");
  const request = requestPinnedHttps(
    new URL("https://letter.example.com/archive"),
    ["93.184.216.34"],
    controller.signal,
    {
      connect: () => Promise.resolve(connection),
      startTls: (_connection, _hostname, signal) => {
        const { promise, reject } = Promise.withResolvers<TransportConnection>();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
    },
  );
  controller.abort(abortReason);
  const rejection = await assertRejects(() => request);
  assertEquals(rejection, abortReason);
  assertEquals(connection.closeCount > 0, true);
});
