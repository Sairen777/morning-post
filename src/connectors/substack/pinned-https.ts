import ipaddr from "ipaddr.js";

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const READ_BUFFER_BYTES = 16 * 1024;

export interface TransportConnection {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
}

export interface PinnedHttpsDependencies {
  connect?: (address: string, signal?: AbortSignal) => Promise<TransportConnection>;
  startTls?: (
    connection: TransportConnection,
    hostname: string,
  ) => Promise<TransportConnection>;
  maxResponseBytes?: number;
}

const defaultConnect = (
  address: string,
  signal?: AbortSignal,
): Promise<TransportConnection> => Deno.connect({ hostname: address, port: 443, signal });

const defaultStartTls = (
  connection: TransportConnection,
  hostname: string,
): Promise<TransportConnection> =>
  Deno.startTls(connection as Deno.TcpConn, { hostname });

export async function requestPinnedHttps(
  url: URL,
  addresses: string[],
  signal?: AbortSignal,
  dependencies: PinnedHttpsDependencies = {},
): Promise<Response> {
  validateRequest(url, addresses);
  const connect = dependencies.connect ?? defaultConnect;
  const startTls = dependencies.startTls ?? defaultStartTls;
  const maxResponseBytes = dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maximum response size must be a positive integer");
  }

  let connection: TransportConnection | undefined;
  const abortConnection = () => {
    try {
      connection?.close();
    } catch {
      // Closing an already-consumed TCP connection is harmless during cancellation.
    }
  };
  signal?.addEventListener("abort", abortConnection, { once: true });
  try {
    connection = await connectTlsToAddress(
      addresses,
      url.hostname,
      connect,
      startTls,
      signal,
      (activeConnection) => {
        connection = activeConnection;
      },
    );
    if (signal?.aborted) throw abortReason(signal);
    await writeAll(connection, buildRequest(url), signal);
    return await readResponse(connection, maxResponseBytes, signal);
  } finally {
    signal?.removeEventListener("abort", abortConnection);
    abortConnection();
  }
}

function validateRequest(url: URL, addresses: string[]): void {
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw new Error("pinned request must use HTTPS without credentials or a custom port");
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpLiteral(address))) {
    throw new Error("pinned request requires at least one public IP address");
  }
}

function isPublicIpLiteral(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address()
      : parsed;
    return normalized.range() === "unicast";
  } catch {
    return false;
  }
}

async function connectTlsToAddress(
  addresses: string[],
  hostname: string,
  connect: NonNullable<PinnedHttpsDependencies["connect"]>,
  startTls: NonNullable<PinnedHttpsDependencies["startTls"]>,
  signal: AbortSignal | undefined,
  setActiveConnection: (connection: TransportConnection) => void,
): Promise<TransportConnection> {
  let lastError: unknown;
  for (const address of addresses) {
    let connection: TransportConnection | undefined;
    try {
      if (signal?.aborted) throw abortReason(signal);
      connection = await connect(address, signal);
      setActiveConnection(connection);
      if (signal?.aborted) throw abortReason(signal);
      const tlsConnection = await startTls(connection, hostname);
      connection = undefined;
      setActiveConnection(tlsConnection);
      return tlsConnection;
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // Try the next validated address after closing this failed connection.
      }
      if (signal?.aborted) throw abortReason(signal);
      lastError = error;
    }
  }
  throw new Error("could not connect to the publication host", { cause: lastError });
}

function buildRequest(url: URL): Uint8Array {
  const path = `${url.pathname}${url.search}`;
  return new TextEncoder().encode(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${url.hostname}\r\n` +
      "Accept: application/json\r\n" +
      "Accept-Encoding: identity\r\n" +
      "Connection: close\r\n" +
      "User-Agent: Morning-Post/1\r\n\r\n",
  );
}

async function writeAll(
  connection: TransportConnection,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    if (signal?.aborted) throw abortReason(signal);
    const written = await connection.write(bytes.subarray(offset));
    if (written <= 0) throw new Error("publication connection stopped accepting request data");
    offset += written;
  }
}

class ConnectionReader {
  private readonly readBuffer = new Uint8Array(READ_BUFFER_BYTES);
  private offset = 0;
  private length = 0;

  constructor(private readonly connection: TransportConnection) {}

  async readLine(maxBytes: number, signal?: AbortSignal): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length <= maxBytes) {
      const byte = await this.readByte(signal);
      if (byte === null) throw new Error("publication response ended before its headers completed");
      if (byte === 10 && bytes.at(-1) === 13) {
        bytes.pop();
        return new TextDecoder().decode(Uint8Array.from(bytes));
      }
      bytes.push(byte);
    }
    throw new Error("publication response headers exceed byte limit");
  }

  async readExactly(length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      if (signal?.aborted) throw abortReason(signal);
      if (this.offset < this.length) {
        const available = Math.min(length - outputOffset, this.length - this.offset);
        output.set(this.readBuffer.subarray(this.offset, this.offset + available), outputOffset);
        this.offset += available;
        outputOffset += available;
        continue;
      }
      const count = await this.connection.read(output.subarray(outputOffset));
      if (count === null) throw new Error("publication response body ended unexpectedly");
      if (count === 0) continue;
      outputOffset += count;
    }
    return output;
  }

  async readToEnd(maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (this.offset < this.length) {
      const buffered = this.readBuffer.slice(this.offset, this.length);
      chunks.push(buffered);
      total += buffered.length;
      this.offset = this.length;
    }
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const buffer = new Uint8Array(Math.min(READ_BUFFER_BYTES, maxBytes - total + 1));
      const count = await this.connection.read(buffer);
      if (count === null) return concatenate(chunks, total);
      if (count === 0) continue;
      total += count;
      if (total > maxBytes) throw new Error("response exceeds byte limit");
      chunks.push(buffer.slice(0, count));
    }
  }

  private async readByte(signal?: AbortSignal): Promise<number | null> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.offset >= this.length) {
      const count = await this.connection.read(this.readBuffer);
      if (count === null) return null;
      if (count === 0) return await this.readByte(signal);
      this.offset = 0;
      this.length = count;
    }
    return this.readBuffer[this.offset++];
  }
}

async function readResponse(
  connection: TransportConnection,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  const reader = new ConnectionReader(connection);
  const statusLine = await reader.readLine(MAX_HEADER_BYTES, signal);
  const statusMatch = /^HTTP\/1\.[01] ([2-5]\d\d)(?: (.*))?$/.exec(statusLine);
  if (!statusMatch) throw new Error("publication response status line is invalid");

  const headers = new Headers();
  let headerBytes = statusLine.length + 2;
  while (true) {
    const line = await reader.readLine(MAX_HEADER_BYTES - headerBytes, signal);
    headerBytes += line.length + 2;
    if (line === "") break;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("publication response header is invalid");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error("publication response header is invalid");
    }
    if (name === "content-length" && headers.has(name)) {
      throw new Error("publication response has ambiguous content length");
    }
    headers.append(name, value);
  }

  const contentEncoding = headers.get("content-encoding")?.toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error("publication response uses an unsupported content encoding");
  }
  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
  const contentLength = headers.get("content-length");
  if (transferEncoding && contentLength !== null) {
    throw new Error("publication response has ambiguous body framing");
  }

  let body: Uint8Array;
  if (transferEncoding !== undefined) {
    if (transferEncoding !== "chunked") {
      throw new Error("publication response uses unsupported transfer encoding");
    }
    body = await readChunkedBody(reader, maxResponseBytes, signal);
    headers.delete("transfer-encoding");
  } else if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error("publication response content length is invalid");
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maxResponseBytes) {
      throw new Error("response exceeds byte limit");
    }
    body = await reader.readExactly(length, signal);
  } else {
    body = await reader.readToEnd(maxResponseBytes, signal);
  }

  return new Response(Uint8Array.from(body).buffer, {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  });
}

async function readChunkedBody(
  reader: ConnectionReader,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const sizeLine = await reader.readLine(MAX_HEADER_BYTES, signal);
    const sizeText = sizeLine.split(";", 1)[0].trim();
    if (!/^[\da-fA-F]+$/.test(sizeText)) throw new Error("publication response chunk size is invalid");
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) throw new Error("publication response chunk size is invalid");
    if (size === 0) {
      while (await reader.readLine(MAX_HEADER_BYTES, signal) !== "") {
        // Trailer fields are intentionally ignored.
      }
      return concatenate(chunks, total);
    }
    total += size;
    if (total > maxResponseBytes) throw new Error("response exceeds byte limit");
    chunks.push(await reader.readExactly(size, signal));
    const terminator = await reader.readExactly(2, signal);
    if (terminator[0] !== 13 || terminator[1] !== 10) {
      throw new Error("publication response chunk is invalid");
    }
  }
}

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}
