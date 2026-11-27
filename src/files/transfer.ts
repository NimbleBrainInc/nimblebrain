/**
 * The host's side of a transfer (`contracts/files/CONTRACT.md` §7, §10): every
 * body the files plugin holds moves between it and the host by a short-lived
 * URL the plugin issued, and this client is the only code that fetches one.
 *
 * Each transfer goes through the SSRF-guarded fetch with redirects refused,
 * and only to a destination the binding authorises: the origin of its own
 * server URL, an origin the operator listed for it (exact scheme, host and
 * port, at the scheme listed), or, for a binding the runtime starts over
 * stdio, a literal loopback address on any port. A name is resolved once; one
 * that resolves to a loopback, link-local, unspecified or multicast address is
 * refused, and the request connects to the address that was checked. This is
 * the transfer's whole destination policy: the guarded fetch checks it in
 * place of the connector URL rule, whose limits (no private address, plain
 * http only in-cluster) are a connector endpoint's, not a transfer's.
 *
 * A transfer URL is a bearer capability. It never appears in an error, a log
 * line or anything a caller can show: every failure here is a
 * {@link TransferError} naming only what went wrong.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { TransferDestinations } from "../plugins/bound-servers.ts";
import { createSsrfGuardedFetch } from "../tools/ssrf-guarded-fetch.ts";

/** A failed transfer. Its message never holds the URL. */
export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

/** The headers a host owns on a PUT, which an upload's own `headers` may never name (§7). */
const FORBIDDEN_UPLOAD_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
  "authorization",
]);

/** Whether an upload's `headers` name a field the host owns. */
export function forbiddenUploadHeader(headers: Record<string, string>): string | null {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_UPLOAD_HEADERS.has(lower) || lower.startsWith("proxy-")) return name;
  }
  return null;
}

/** The longest transfer URL the contract allows. */
const MAX_URL_LENGTH = 4096;

/** A resolved address. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a name to its addresses: `dns.lookup(name, { all: true })` by default. */
export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookup: AddressLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

export interface TransferClientOptions {
  destinations: TransferDestinations;
  lookup?: AddressLookup;
  /** The fetch the guarded fetch wraps. Default: the global one. */
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

/** One `bytes=a-b` range, inclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

/** A download's answer, checked: its status, the length it streams, and the body. */
export interface DownloadAnswer {
  status: 200 | 206;
  /** The bytes `body` streams, checked against the record (or the range) before any was read. */
  length: number;
  /** For a 206, the `Content-Range` the answer named. */
  contentRange?: string;
  /** Counted: it errors on a byte past `length`, or when it ends short. */
  body: ReadableStream<Uint8Array>;
}

export interface TransferClient {
  /** GET a download URL for a body of `size` bytes, or one range of it. */
  download(url: string, expect: { size: number; range?: ByteRange }): Promise<DownloadAnswer>;
  /** PUT exactly `size` bytes of `body` to an upload URL with the upload's own `headers`. */
  upload(
    url: string,
    upload: { headers: Record<string, string>; size: number; body: ReadableStream<Uint8Array> },
  ): Promise<void>;
}

/** Whether an IP literal is loopback. */
function isLoopbackAddress(address: string): boolean {
  const v4 = mappedV4(address) ?? address;
  if (isIP(v4) === 4) return v4.startsWith("127.");
  return address === "::1";
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, or null. */
function mappedV4(address: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (m) return m[1] ?? null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1] ?? "0", 16);
  const lo = Number.parseInt(hex[2] ?? "0", 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Whether an address is one a resolved name may never reach: loopback,
 * link-local, unspecified or multicast (§7).
 */
export function isRefusedAddress(address: string): boolean {
  const v4 = mappedV4(address) ?? (isIP(address) === 4 ? address : null);
  if (v4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254) || (a >= 224 && a <= 239);
  }
  const v6 = address.toLowerCase();
  return (
    v6 === "::1" ||
    v6 === "::" ||
    /^fe[89ab][0-9a-f]:/.test(v6) ||
    v6.startsWith("ff") ||
    /^0*:0*:0*:0*:0*:0*:0*:0*$/.test(v6)
  );
}

/** `URL.hostname` without its IPv6 brackets. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/** A transfer URL that meets §7's form, or a refusal. */
function parseTransferUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new TransferError("the transfer URL is not a URL the contract allows");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TransferError("the transfer URL is not a URL the contract allows");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TransferError("the transfer URL is not a URL the contract allows");
  }
  return url;
}

/** How a destination is reached: a stdio binding's loopback, or an authorised origin. */
type Destination = { kind: "loopback" } | { kind: "origin" };

/** The destination `url` names, when the binding authorises it; otherwise a refusal. */
function authorise(url: URL, destinations: TransferDestinations): Destination {
  const host = bareHost(url);
  if (destinations.loopback && isIP(host) !== 0 && isLoopbackAddress(host)) {
    return { kind: "loopback" };
  }
  if (url.origin === destinations.serverOrigin || destinations.listed.includes(url.origin)) {
    return { kind: "origin" };
  }
  throw new TransferError(
    "the transfer URL points at a destination the binding does not authorise",
  );
}

/**
 * The checked address to connect to for an authorised origin: an IP literal
 * as written, a name resolved once. Refused when any address it resolves to
 * (or the literal) is loopback, link-local, unspecified or multicast.
 */
async function checkedAddress(url: URL, lookup: AddressLookup): Promise<string> {
  const host = bareHost(url);
  if (isIP(host) !== 0) {
    if (isRefusedAddress(host)) {
      throw new TransferError("the transfer URL's address is one the host never reaches");
    }
    return host;
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new TransferError("the transfer URL's host did not resolve");
  }
  if (addresses.length === 0) throw new TransferError("the transfer URL's host did not resolve");
  if (addresses.some((a) => isRefusedAddress(a.address))) {
    throw new TransferError(
      "the transfer URL's host resolves to an address the host never reaches",
    );
  }
  return (addresses[0] as ResolvedAddress).address;
}

/** The request for `url` sent to `address` instead of its name, with its own `Host` and TLS name kept. */
function pinned(url: URL, init: RequestInit, address: string): { url: URL; init: RequestInit } {
  const dialed = new URL(url.toString());
  dialed.hostname = address.includes(":") ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const tls = url.protocol === "https:" ? { tls: { serverName: bareHost(url) } } : {};
  return { url: dialed, init: { ...init, headers, ...tls } as RequestInit };
}

/** A stream that passes `source` through, erroring on a byte past `length` or a short end. */
export function countedStream(
  source: ReadableStream<Uint8Array>,
  length: number,
  what: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        controller.error(new TransferError(`${what} failed while streaming`));
        return;
      }
      if (chunk.done) {
        if (seen !== length) {
          controller.error(new TransferError(`${what} ended after ${seen} of ${length} bytes`));
        } else {
          controller.close();
        }
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > length) {
        void reader.cancel().catch(() => {});
        controller.error(new TransferError(`${what} ran past its ${length} bytes`));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The exact `bytes a-b/size` a 206 must name for `range` of a `size`-byte body. */
function expectedContentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}

/** The bytes a download streams: the range's, or the record's size. */
function expectedLength(expect: { size: number; range?: ByteRange }): number {
  return expect.range ? expect.range.end - expect.range.start + 1 : expect.size;
}

/**
 * Why a download's answer is a failed transfer, checked before a byte is read
 * (§7): another status than 200 (206 for a range), an encoded body, a
 * `Content-Length` other than the record's (or the range's), or for a range a
 * `Content-Range` other than the one asked for. Null when it passes.
 */
function downloadProblem(
  res: Response,
  expect: { size: number; range?: ByteRange },
): string | null {
  const want = expect.range ? 206 : 200;
  if (res.status !== want) return `the download answered ${res.status}`;
  const encoding = res.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return "the download answered an encoded body";
  }
  const declared = res.headers.get("content-length")?.trim() ?? "";
  if (!/^\d+$/.test(declared) || Number(declared) !== expectedLength(expect)) {
    return "the download's Content-Length is not the record's";
  }
  if (
    expect.range &&
    res.headers.get("content-range")?.trim() !== expectedContentRange(expect.range, expect.size)
  ) {
    return "the download's Content-Range is not the range asked for";
  }
  return null;
}

/** Create the transfer client for one binding. */
export function createTransferClient(opts: TransferClientOptions): TransferClient {
  const lookup = opts.lookup ?? defaultLookup;
  const base = opts.fetch ?? ((u, i) => fetch(u, i));

  /** The SSRF-guarded fetch for one transfer, connecting where `authorise` and the lookup said. */
  async function send(raw: string, init: RequestInit): Promise<Response> {
    const url = parseTransferUrl(raw);
    const destination = authorise(url, opts.destinations);
    const address =
      destination.kind === "loopback" ? bareHost(url) : await checkedAddress(url, lookup);
    const guarded = createSsrfGuardedFetch(
      (u, i) => base(u, { ...i, decompress: false } as RequestInit),
      {
        authorize: (u) => void authorise(u, opts.destinations),
        redirects: "refuse",
        dial: async (u, i) => pinned(u, i, address),
      },
    );
    try {
      return await guarded(url.toString(), init);
    } catch (err) {
      if (err instanceof TransferError) throw err;
      const why = err instanceof Error && err.message.includes("redirect") ? "redirect" : "request";
      throw new TransferError(
        why === "redirect" ? "the transfer answered a redirect" : "the transfer request failed",
      );
    }
  }

  return {
    async download(url, expect) {
      const headers: Record<string, string> = { "accept-encoding": "identity" };
      if (expect.range) headers.range = `bytes=${expect.range.start}-${expect.range.end}`;
      const res = await send(url, { method: "GET", headers });
      const problem = downloadProblem(res, expect);
      if (problem) {
        void res.body?.cancel().catch(() => {});
        throw new TransferError(problem);
      }
      const length = expectedLength(expect);
      const contentRange = res.headers.get("content-range")?.trim();
      const body = res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
      return {
        status: expect.range ? 206 : 200,
        length,
        ...(expect.range && contentRange ? { contentRange } : {}),
        body: countedStream(body, length, "the download"),
      };
    },

    async upload(url, upload) {
      const named = forbiddenUploadHeader(upload.headers);
      if (named) throw new TransferError(`the upload's headers name ${named}, which the host owns`);
      const res = await send(url, {
        method: "PUT",
        headers: {
          ...upload.headers,
          "content-length": String(upload.size),
          "accept-encoding": "identity",
        },
        body: countedStream(upload.body, upload.size, "the upload"),
        duplex: "half",
      } as RequestInit);
      void res.body?.cancel().catch(() => {});
      if (res.status < 200 || res.status >= 300) {
        throw new TransferError(`the upload answered ${res.status}`);
      }
    },
  };
}
