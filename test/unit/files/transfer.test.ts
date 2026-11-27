/**
 * The transfer client (`src/files/transfer.ts`) against the files contract's
 * host obligations (CONTRACT.md §7, §10): where it may connect, what it sends,
 * and what it checks before a byte of an answer is used. The network is a fake
 * fetch, so every case sees the request exactly as it would go out.
 */

import { describe, expect, test } from "bun:test";
import {
  type AddressLookup,
  createTransferClient,
  isRefusedAddress,
  TransferError,
} from "../../../src/files/transfer.ts";
import type { TransferDestinations } from "../../../src/plugins/bound-servers.ts";

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
}

/** A fake network: records what is sent and answers with `respond`. */
function network(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof ReadableStream
        ? new Uint8Array(await new Response(init.body).arrayBuffer())
        : undefined;
    const one: Sent = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(body ? { body } : {}),
    };
    sent.push(one);
    return respond(one);
  };
  return { sent, fetch };
}

const STDIO: TransferDestinations = { serverOrigin: null, listed: [], loopback: true };
const REMOTE: TransferDestinations = {
  serverOrigin: "https://files.example.com",
  listed: ["https://bucket.example.net"],
  loopback: false,
};
const PUBLIC_LOOKUP: AddressLookup = async () => [{ address: "203.0.113.7", family: 4 }];

function ok(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength), ...headers },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TransferError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("destinations", () => {
  test("a stdio binding reaches a literal loopback address on any port", async () => {
    const net = network(() => ok("hello"));
    const client = createTransferClient({ destinations: STDIO, fetch: net.fetch });
    const got = await client.download("http://127.0.0.1:41234/t/abc.def", { size: 5 });
    expect(await text(got.body)).toBe("hello");
    expect(net.sent[0]?.url).toBe("http://127.0.0.1:41234/t/abc.def");
  });

  test("a stdio binding never reaches loopback by name, or any other host", async () => {
    const net = network(() => ok("x"));
    const client = createTransferClient({ destinations: STDIO, fetch: net.fetch });
    for (const url of ["http://localhost:4000/t/x", "https://elsewhere.example.com/t/x"]) {
      expect(await refusal(client.download(url, { size: 1 }))).toContain("does not authorise");
    }
    expect(net.sent).toEqual([]);
  });

  test("a remote binding reaches its server's origin and the listed ones, at the address it checked", async () => {
    const net = network(() => ok("hi"));
    const client = createTransferClient({
      destinations: REMOTE,
      fetch: net.fetch,
      lookup: PUBLIC_LOOKUP,
    });
    await client.download("https://files.example.com/t/1", { size: 2 });
    await client.download("https://bucket.example.net/k?sig=1", { size: 2 });
    expect(net.sent.map((s) => s.url)).toEqual([
      "https://203.0.113.7/t/1",
      "https://203.0.113.7/k?sig=1",
    ]);
    expect(net.sent.map((s) => s.headers.get("host"))).toEqual([
      "files.example.com",
      "bucket.example.net",
    ]);
  });

  test("an unlisted origin, another port of a listed one, or another scheme is refused unsent", async () => {
    const net = network(() => ok("x"));
    const client = createTransferClient({
      destinations: REMOTE,
      fetch: net.fetch,
      lookup: PUBLIC_LOOKUP,
    });
    for (const url of [
      "https://other.example.com/t/1",
      "https://bucket.example.net:8443/k",
      "http://files.example.com/t/1",
      "ftp://files.example.com/t/1",
      "https://user:pw@files.example.com/t/1",
    ]) {
      await refusal(client.download(url, { size: 1 }));
    }
    expect(net.sent).toEqual([]);
  });

  test("a remote binding pointing at loopback is refused, literal or by a name that resolves there", async () => {
    const net = network(() => ok("x"));
    const loopbackOrigin: TransferDestinations = {
      serverOrigin: "https://files.example.com",
      listed: ["http://127.0.0.1:9000"],
      loopback: false,
    };
    const client = createTransferClient({
      destinations: loopbackOrigin,
      fetch: net.fetch,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await refusal(client.download("http://127.0.0.1:9000/t/1", { size: 1 }));
    expect(await refusal(client.download("https://files.example.com/t/1", { size: 1 }))).toContain(
      "resolves to an address",
    );
    expect(net.sent).toEqual([]);
  });

  test("refused addresses: loopback, link-local, unspecified, multicast, mapped forms", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1"]) {
      expect(isRefusedAddress(a)).toBe(true);
    }
    for (const a of ["::", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"]) {
      expect(isRefusedAddress(a)).toBe(true);
    }
    for (const a of ["203.0.113.7", "10.0.0.5", "2001:db8::1"]) {
      expect(isRefusedAddress(a)).toBe(false);
    }
  });

  test("an overlong URL is refused", async () => {
    const client = createTransferClient({
      destinations: STDIO,
      fetch: network(() => ok("")).fetch,
    });
    await refusal(client.download(`http://127.0.0.1:1/t/${"a".repeat(4096)}`, { size: 0 }));
  });
});

describe("downloads", () => {
  const client = (respond: (s: Sent) => Response) => {
    const net = network(respond);
    return { net, client: createTransferClient({ destinations: STDIO, fetch: net.fetch }) };
  };
  const URL_ = "http://127.0.0.1:5000/t/a.b";

  test("asks for identity encoding and sends no credential or cookie", async () => {
    const { net, client: c } = client(() => ok("abc"));
    await c.download(URL_, { size: 3 });
    const h = net.sent[0]!.headers;
    expect(h.get("accept-encoding")).toBe("identity");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();
  });

  test("a redirect is a failed transfer, and is not followed", async () => {
    const { net, client: c } = client(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:5000/x" } }),
    );
    expect(await refusal(c.download(URL_, { size: 1 }))).toContain("redirect");
    expect(net.sent).toHaveLength(1);
  });

  test("an encoded body, another status, or a length other than the record's is refused", async () => {
    for (const res of [
      ok("abc", { "content-encoding": "gzip" }),
      new Response("abc", { status: 201, headers: { "content-length": "3" } }),
      ok("abcd"),
    ]) {
      const { client: c } = client(() => res);
      await refusal(c.download(URL_, { size: 3 }));
    }
  });

  test("an answer that runs past its length or ends short errors while streaming", async () => {
    // Declares the right length, then sends more: the counted stream stops it.
    const long = new Response(new Blob(["abcdef"]).stream(), {
      headers: { "content-length": "3" },
    });
    const { client: c } = client(() => long);
    const got = await c.download(URL_, { size: 3 });
    await expect(text(got.body)).rejects.toThrow(/past/);
    const short = new Response(new Blob(["ab"]).stream(), { headers: { "content-length": "3" } });
    const { client: c2 } = client(() => short);
    const got2 = await c2.download(URL_, { size: 3 });
    await expect(text(got2.body)).rejects.toThrow(/ended after 2 of 3/);
  });

  test("a range passes through and its Content-Range is checked", async () => {
    const { net, client: c } = client(
      () =>
        new Response("cd", {
          status: 206,
          headers: { "content-length": "2", "content-range": "bytes 2-3/6" },
        }),
    );
    const got = await c.download(URL_, { size: 6, range: { start: 2, end: 3 } });
    expect(net.sent[0]!.headers.get("range")).toBe("bytes=2-3");
    expect(got).toMatchObject({ status: 206, length: 2, contentRange: "bytes 2-3/6" });
    expect(await text(got.body)).toBe("cd");

    const { client: wrong } = client(
      () =>
        new Response("cd", {
          status: 206,
          headers: { "content-length": "2", "content-range": "bytes 0-1/6" },
        }),
    );
    await refusal(wrong.download(URL_, { size: 6, range: { start: 2, end: 3 } }));
  });
});

describe("uploads", () => {
  const URL_ = "http://127.0.0.1:5000/t/u.p";
  const body = () => new Blob(["hello"]).stream();

  test("sends the upload's headers, its own Content-Length, and the body streamed", async () => {
    const net = network(() => new Response(null, { status: 204 }));
    const c = createTransferClient({ destinations: STDIO, fetch: net.fetch });
    await c.upload(URL_, { headers: { "x-amz-meta-a": "1" }, size: 5, body: body() });
    const sent = net.sent[0]!;
    expect(sent.method).toBe("PUT");
    expect(sent.headers.get("content-length")).toBe("5");
    expect(sent.headers.get("x-amz-meta-a")).toBe("1");
    expect(new TextDecoder().decode(sent.body)).toBe("hello");
  });

  test("refuses headers the host owns before sending anything", async () => {
    const net = network(() => new Response(null, { status: 204 }));
    const c = createTransferClient({ destinations: STDIO, fetch: net.fetch });
    for (const name of [
      "Host",
      "content-length",
      "Transfer-Encoding",
      "Cookie",
      "Proxy-Foo",
      "TE",
    ]) {
      await refusal(c.upload(URL_, { headers: { [name]: "x" }, size: 5, body: body() }));
    }
    expect(net.sent).toEqual([]);
  });

  test("a non-2xx answer or a redirect is a failed upload", async () => {
    for (const status of [403, 307]) {
      const net = network(
        () => new Response(null, { status, headers: { location: "http://127.0.0.1:1/" } }),
      );
      const c = createTransferClient({ destinations: STDIO, fetch: net.fetch });
      await refusal(c.upload(URL_, { headers: {}, size: 5, body: body() }));
    }
  });

  test("a body other than its declared size fails the upload", async () => {
    const net = network(() => new Response(null, { status: 204 }));
    const c = createTransferClient({ destinations: STDIO, fetch: net.fetch });
    await refusal(c.upload(URL_, { headers: {}, size: 4, body: body() }));
  });
});
