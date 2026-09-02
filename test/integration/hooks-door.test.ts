import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import {
  HOOK_ANON_BUCKET_MAX,
  HOOK_BUCKET_WINDOW_MS,
  HOOK_WORKSPACE_BUCKET_MAX,
  hooksRoutes,
} from "../../src/api/routes/hooks.ts";
import type { AppContext } from "../../src/api/types.ts";
import { registrationKey } from "../../src/hooks/registrations.ts";
import {
  deliveryIdHash,
  type HookIdentity,
  newDeliveryId,
} from "../../src/hooks/token.ts";
import { HOOK_ROTATION_GRACE_MS, type HookRegistration } from "../../src/hooks/types.ts";
import { RequestRateLimiter } from "../../src/api/rate-limiter.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

/**
 * The hooks door, end to end over HTTP.
 *
 * The negative half is the point. Every way a delivery can fail to be
 * legitimate has to produce ONE indistinguishable answer — a bare 404 with no
 * body — or the door becomes an oracle a prober can walk: "this connector
 * exists but that vendor does not", "this key id is retired rather than
 * invented". Each test below asserts a specific way in, and the shared
 * `expectIndistinguishable404` is what pins them all to the same answer.
 */

const TID = "tenant-a";
const KEY = randomBytes(32);
const OTHER_TENANT_KEY = randomBytes(32);
const IDENTITY: HookIdentity = { tid: TID, key: KEY };

const CONNECTOR = "acme-billing-mcp";
const VENDOR = "acme";
const KID = "hk_current0000001";
/** The id a vendor holds. Fixed per run so a test can post to a known URL. */
const DELIVERY_ID = newDeliveryId();
/** An id no registration was ever minted for. */
const UNKNOWN_ID = newDeliveryId();
const ROUTE = "/ingest/acme";
const CONNECTOR_URL = "https://connector.internal/mcp";

let workDir: string;
let cleanup: () => void;
let store: WorkspaceStore;
let wsId: string;
/** Every request the door forwarded, captured instead of sent. */
let forwarded: { url: string; init: RequestInit }[] = [];
/** What the fake connector answers. Reassigned per test. */
let upstreamResponse: () => Response;
/** Log lines the door emitted during a test. */
let logLines: string[] = [];

/**
 * Run `fn` with every log line the runtime writes captured.
 *
 * The logger writes to stderr — both directly (JSON mode) and through
 * `console.error` (pretty mode) — so both have to be intercepted, or an
 * assertion that a secret never appears passes by capturing nothing.
 */
async function capturingLogs(fn: () => Promise<void>): Promise<void> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalError = console.error;
  const record = (...parts: unknown[]) => {
    logLines.push(parts.map((p) => (typeof p === "string" ? p : String(p))).join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    record(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  console.error = record;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalError;
  }
}

function registration(over: Partial<HookRegistration> = {}): HookRegistration {
  return {
    connector: CONNECTOR,
    vendor: VENDOR,
    kid: KID,
    idHash: deliveryIdHash(DELIVERY_ID),
    createdAt: new Date().toISOString(),
    route: ROUTE,
    ...over,
  };
}

/** The URL a vendor was handed, for a given delivery id. */
function hookUrl(id: string = DELIVERY_ID): string {
  return `/v1/hooks/${id}`;
}

async function seedWorkspace(opts: {
  hooks?: Record<string, HookRegistration>;
  installed?: boolean;
  /** Which workspace to seed. Defaults to the one every other test uses. */
  id?: string;
}): Promise<void> {
  await store.update(opts.id ?? wsId, {
    bundles:
      opts.installed === false
        ? []
        : [
            {
              url: CONNECTOR_URL,
              serverName: CONNECTOR,
              transport: { type: "streamable-http", auth: { type: "bearer", token: "operator" } },
            },
          ],
    hooks: opts.hooks ?? { [registrationKey(CONNECTOR, VENDOR)]: registration() },
  });
}

/** Records the forward instead of making it, and answers as the connector would. */
const captureFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  forwarded.push({ url: String(url), init: init ?? {} });
  return upstreamResponse();
}) as unknown as typeof fetch;

function makeCtx(over: Partial<AppContext> = {}): AppContext {
  return {
    isDevMode: false,
    runtime: { getWorkspaceStore: () => store, getAllowInsecureRemotes: () => false },
    ...over,
  } as unknown as AppContext;
}

function makeApp(identity: HookIdentity = IDENTITY): Hono {
  const routes = hooksRoutes(makeCtx(), {
    identity,
    // Fresh buckets per app so one test's traffic never counts against
    // another's, sized from the door's own constants so a deliberate resize
    // moves the fixture and the boundary tests together.
    anonLimiter: new RequestRateLimiter(HOOK_ANON_BUCKET_MAX, HOOK_BUCKET_WINDOW_MS),
    workspaceLimiter: new RequestRateLimiter(HOOK_WORKSPACE_BUCKET_MAX, HOOK_BUCKET_WINDOW_MS),
    fetchImpl: captureFetch,
  });
  if (!routes) throw new Error("hooks routes should mount when an identity is supplied");
  return new Hono().route("/", routes);
}

function deliver(
  app: Hono,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.fetch(
    new Request(`https://runtime.example${path}`, {
      method: "POST",
      body: "{}",
      // A fresh source per request so the pre-token bucket, which is per
      // source, never has one test's traffic count against another's.
      headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}`, ...(init.headers as Record<string, string>) },
      ...init,
    }),
  );
}

/** Every rejection must look like every other rejection. */
async function expectIndistinguishable404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
  expect(forwarded).toHaveLength(0);
}

beforeEach(async () => {
  ({ workDir, cleanup } = makeTestWorkDir("hooks-door"));
  store = new WorkspaceStore(workDir);
  const ws = await store.create("Hooks Test");
  wsId = ws.id;
  forwarded = [];
  logLines = [];
  upstreamResponse = () => new Response("ok", { status: 202 });
  await seedWorkspace({});
});

afterEach(() => {
  cleanup();
});

describe("a legitimate delivery", () => {
  test("is forwarded to the connector's declared route", async () => {
    const res = await deliver(makeApp(), hookUrl());
    expect(res.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toBe("https://connector.internal/ingest/acme");
  });

  test("returns the connector's own status to the vendor", async () => {
    // The bundle is the party that knows whether a delivery was accepted, so a
    // runtime that rewrote this would be deciding on its behalf whether the
    // vendor should retry.
    upstreamResponse = () => new Response("busy", { status: 503 });
    const res = await deliver(makeApp(), hookUrl());
    expect(res.status).toBe(503);
  });

  test("carries no kid header — the edge would strip it, so nothing stamps one", async () => {
    // The reserved `x-nb-*` namespace is stripped at the edge by rule, because
    // it cannot tell a runtime-stamped member from a caller-forged one. A
    // stamped kid would reach nothing and read as a broken pipeline whose
    // obvious repair is a hole in that rule. Correlation lives in the log line
    // asserted further down instead.
    await deliver(makeApp(), hookUrl());
    const headers = forwarded[0]?.init.headers as Headers;
    expect(headers.get("x-nb-hook-kid")).toBeNull();
    expect([...headers.keys()].filter((k) => k.startsWith("x-nb-"))).toEqual([]);
  });

  test("strips an inbound x-nb-* header the caller invented", async () => {
    await deliver(makeApp(), hookUrl(), {
      headers: { "x-nb-hook-kid": "hk_forged", "x-nb-future-thing": "v" },
    });
    const headers = forwarded[0]?.init.headers as Headers;
    expect(headers.get("x-nb-hook-kid")).toBeNull();
    expect(headers.get("x-nb-future-thing")).toBeNull();
  });

  test("reaches the connector byte-identical, for a binary body", async () => {
    // A JSON fixture would round-trip through a parser that has no business
    // being on this path at all; binary bytes are what prove nothing touched it.
    const body = new Uint8Array(256);
    for (let i = 0; i < body.length; i++) body[i] = i;
    await deliver(makeApp(), hookUrl(), {
      body,
      headers: { "content-type": "application/octet-stream" },
    });
    const sent = forwarded[0]?.init.body as Uint8Array;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent)).toEqual(Array.from(body));
  });

  test("does not forward an inbound identity header", async () => {
    await deliver(makeApp(), hookUrl(), {
      headers: { authorization: "Bearer forged", "x-tenant-id": "tenant-b" },
    });
    const headers = forwarded[0]?.init.headers as Headers;
    expect(headers.get("x-tenant-id")).toBeNull();
    // `authorization` is replaced by the connection's own credential, never the
    // caller's.
    expect(headers.get("authorization")).toBe("Bearer operator");
  });
});

describe("the response the vendor gets", () => {
  test("carries no content-encoding — fetch decoded the body, the header would lie", async () => {
    // `fetch` decompresses transparently but leaves `content-encoding` and the
    // COMPRESSED `content-length` on the response. Copying either tells the
    // vendor gzip and hands it plaintext: its client fails to decode, scores the
    // delivery failed, and redelivers — inverting the "a 2xx means durably
    // recorded" contract the docs give a bundle author.
    upstreamResponse = () =>
      new Response('{"ok":true}', {
        status: 202,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "45",
        },
      });
    const res = await deliver(makeApp(), hookUrl());
    expect(res.status).toBe(202);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    // The parts that DO describe the returned body still travel.
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  test("drops the hop headers but keeps the connector's own", async () => {
    upstreamResponse = () =>
      new Response("ok", {
        status: 202,
        headers: {
          "x-connector-note": "kept",
          connection: "close",
          "keep-alive": "timeout=5",
        },
      });
    const res = await deliver(makeApp(), hookUrl());
    // These describe the hop the runtime made, not the one it is answering on.
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
    // `transfer-encoding` is stripped by the fetch layer before it reaches the
    // header copy, so asserting its absence here would pass without the delete;
    // `hooks-forward.test.ts` covers the strip list itself.
    expect(res.headers.get("x-connector-note")).toBe("kept");
  });
});

describe("every way a delivery is refused looks the same", () => {
  test("an id that is not a delivery id at all", async () => {
    await expectIndistinguishable404(await deliver(makeApp(), hookUrl("not-an-id")));
  });

  test("a well-formed id no registration was minted for", async () => {
    // The replacement for every "sealed under the wrong key / for the wrong
    // tenant" case. Those asked whether a capability minted by someone else's
    // authority works here; an opaque id has no authority to forge, so the whole
    // class collapses into one question — does this id hash to a registration —
    // and this is it.
    await expectIndistinguishable404(await deliver(makeApp(), hookUrl(UNKNOWN_ID)));
  });

  test("an id that is a PREFIX of the real one", async () => {
    // A scan comparing loosely would admit this. The comparison is over whole
    // hashes, so a prefix is simply a different id.
    await expectIndistinguishable404(
      await deliver(makeApp(), hookUrl(DELIVERY_ID.slice(0, -1))),
    );
  });

  test("another workspace's id does not reach this workspace's connector", async () => {
    // The isolation the sealed `wid` used to carry. Resolution is now a lookup,
    // so the property has to be asserted against the lookup: an id minted for
    // one workspace forwards for THAT workspace, and nothing about the door's
    // scan may let it land on a neighbour's registration.
    const other = await store.create({ name: "other", ownerId: "usr_other" });
    const otherId = newDeliveryId();
    await seedWorkspace({
      id: other.id,
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({
          idHash: deliveryIdHash(otherId),
          route: "/ingest/other",
        }),
      },
    });

    const res = await deliver(makeApp(), hookUrl(otherId));
    expect(res.status).toBe(202);
    // Forwarded on the OTHER workspace's route, never this one's.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toContain("/ingest/other");
  });

  test("an id whose workspace is gone", async () => {
    // Its registration went with the record, so the scan finds nothing — the
    // same answer as an id that never existed, which is the point.
    const doomed = await store.create({ name: "doomed", ownerId: "usr_doomed" });
    const doomedId = newDeliveryId();
    await seedWorkspace({
      id: doomed.id,
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({ idHash: deliveryIdHash(doomedId) }),
      },
    });
    await store.delete(doomed.id);
    await expectIndistinguishable404(await deliver(makeApp(), hookUrl(doomedId)));
  });

  test("a registration that was never minted", async () => {
    await seedWorkspace({ hooks: {} });
    await expectIndistinguishable404(
      await deliver(makeApp(), hookUrl()),
    );
  });

  test("a registration whose id rotated away, past its grace window", async () => {
    // Replaces a case that asked about the KEY id. The door no longer weighs
    // that: the id and the key rotate together, so a second window would be a
    // second truth to keep in step. The id's window is the one gate.
    await seedWorkspace({
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({
          idHash: deliveryIdHash(newDeliveryId()),
          prevIdHash: deliveryIdHash(DELIVERY_ID),
          rotatedAt: new Date(Date.now() - HOOK_ROTATION_GRACE_MS - 1_000).toISOString(),
        }),
      },
    });
    await expectIndistinguishable404(await deliver(makeApp(), hookUrl()));
  });

  test("a connector that has been uninstalled", async () => {
    // The registration is deliberately left in place here: this asserts the
    // door's own check, independent of uninstall's cleanup.
    await seedWorkspace({ installed: false });
    await expectIndistinguishable404(
      await deliver(makeApp(), hookUrl()),
    );
  });
});

describe("a rotated key id inside the grace window", () => {
  test("still lands, so a rotation never drops an in-flight redelivery", async () => {
    await seedWorkspace({
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({
          kid: "hk_new",
          prevKid: KID,
          rotatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      },
    });
    const res = await deliver(makeApp(), hookUrl());
    expect(res.status).toBe(202);
    expect(forwarded).toHaveLength(1);
  });
});

describe("shape and size", () => {
  test.each(["GET", "PUT", "DELETE", "PATCH"])("%s is refused with 405, not 404", async (method) => {
    // 405 for ANY three-segment path under the prefix, so the difference
    // between "405 here" and "404 there" cannot map out which paths exist.
    const res = await deliver(makeApp(), hookUrl("whatever"), {
      method,
      body: undefined,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("a body over the cap is refused with 413 before the token is opened", async () => {
    const res = await deliver(makeApp(), hookUrl(), {
      body: new Uint8Array(300 * 1024),
    });
    expect(res.status).toBe(413);
    expect(forwarded).toHaveLength(0);
  });

  test("a declared Content-Length over the cap short-circuits the read", async () => {
    const res = await makeApp().fetch(
      new Request(`https://runtime.example${hookUrl()}`, {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(10 * 1024 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe("the two rate-limit buckets", () => {
  /**
   * The door meters twice, on two different keys, and each bucket has a job the
   * other cannot do.
   *
   * The PRE-TOKEN bucket is keyed on the client address and runs before a byte
   * of the body is read or any crypto happens, so a flood of garbage costs the
   * process almost nothing. It is keyed per source precisely so it cannot become
   * the denial it exists to prevent: a single prefix-wide counter would let one
   * flooding host hold it empty and 429 every legitimate delivery.
   *
   * The POST-TOKEN bucket is keyed on `(workspace, connector)` and is the
   * ceiling that actually protects the process — a fifth the size, because it
   * sits below the fleet edge's per-tenant ceiling that forwarded traffic shares
   * with the agent's own tool calls. A burst should fail here, against one
   * workspace, rather than at the edge where it would also starve the agent.
   *
   * Both of those claims are about WHICH key each bucket counts on and WHERE its
   * boundary falls, so the tests below drive each one to exhaustion and assert
   * the position of the first 429 rather than that a 429 eventually happens.
   */

  /** Two fixed sources, outside the range `deliver` randomizes over. */
  const SOURCE_A = "203.0.113.10";
  const SOURCE_B = "203.0.113.11";

  const BAD_TOKEN_PATH = hookUrl(UNKNOWN_ID);

  function goodPath(id: string = DELIVERY_ID): string {
    return hookUrl(id);
  }

  /** A delivery from a named source, so the per-source bucket is deterministic. */
  function deliverFrom(app: Hono, source: string, path: string): Promise<Response> {
    return deliver(app, path, { headers: { "x-forwarded-for": source } });
  }

  /** Drive `count` deliveries and return what each answered. */
  async function drive(app: Hono, source: string, path: string, count: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      statuses.push((await deliverFrom(app, source, path)).status);
    }
    return statuses;
  }

  /**
   * Both buckets answer identically, and that answer is the contract a vendor's
   * retry logic reads: a 429 with a `Retry-After` and nothing else.
   */
  async function expectRateLimited(res: Response): Promise<void> {
    expect(res.status).toBe(429);
    // Derived, not the literal: a deliberate window resize must move this with
    // it, or the header goes on claiming a minute for a window that is not one.
    expect(res.headers.get("Retry-After")).toBe(String(HOOK_BUCKET_WINDOW_MS / 1_000));
    expect(await res.text()).toBe("");
  }

  afterEach(() => {
    // Only the recovery tests move it, but a leaked fake clock would be a
    // confusing failure two files away.
    setSystemTime();
  });

  describe("the pre-token bucket, per source address", () => {
    test("admits exactly its size from one source and 429s the next", async () => {
      const app = makeApp();
      // Driven with a token that will not open: the bucket is consumed BEFORE
      // any crypto, so garbage counts exactly like a legitimate delivery — and
      // driving it this way keeps the workspace bucket, a fifth the size, out
      // of the way of a boundary that would otherwise be unreachable.
      const statuses = await drive(app, SOURCE_A, BAD_TOKEN_PATH, HOOK_ANON_BUCKET_MAX + 1);
      expect(new Set(statuses.slice(0, HOOK_ANON_BUCKET_MAX))).toEqual(new Set([404]));
      expect(statuses.indexOf(429)).toBe(HOOK_ANON_BUCKET_MAX);
      await expectRateLimited(await deliverFrom(app, SOURCE_A, BAD_TOKEN_PATH));
      expect(forwarded).toHaveLength(0);
    });

    test("does not spend another source's allowance, or the workspace's", async () => {
      // The property the per-source key exists for: one flooding host must not
      // be able to 429 everybody else's deliveries. A 202 here also shows the
      // flood never touched the post-token bucket, which nothing in it reached.
      const app = makeApp();
      await drive(app, SOURCE_A, BAD_TOKEN_PATH, HOOK_ANON_BUCKET_MAX + 1);
      expect((await deliverFrom(app, SOURCE_A, BAD_TOKEN_PATH)).status).toBe(429);

      const res = await deliverFrom(app, SOURCE_B, goodPath());
      expect(res.status).toBe(202);
      expect(forwarded).toHaveLength(1);
    });

    test("admits again once its window has passed", async () => {
      const app = makeApp();
      const openedAt = Date.now();
      await drive(app, SOURCE_A, BAD_TOKEN_PATH, HOOK_ANON_BUCKET_MAX + 1);
      expect((await deliverFrom(app, SOURCE_A, BAD_TOKEN_PATH)).status).toBe(429);

      // The limiter reads the wall clock and takes no clock of its own, so the
      // clock is what moves. A real wait would be a minute per bucket.
      setSystemTime(new Date(openedAt + HOOK_BUCKET_WINDOW_MS + 1_000));

      const res = await deliverFrom(app, SOURCE_A, goodPath());
      expect(res.status).toBe(202);
    });
  });

  describe("the post-token bucket, per workspace and connector", () => {
    test("admits exactly its size for one workspace and 429s the next", async () => {
      const app = makeApp();
      const statuses = await drive(app, SOURCE_A, goodPath(), HOOK_WORKSPACE_BUCKET_MAX + 1);
      expect(new Set(statuses.slice(0, HOOK_WORKSPACE_BUCKET_MAX))).toEqual(new Set([202]));
      expect(statuses.indexOf(429)).toBe(HOOK_WORKSPACE_BUCKET_MAX);
      await expectRateLimited(await deliverFrom(app, SOURCE_A, goodPath()));
      // The refused deliveries never reached the connector, and the pre-token
      // bucket never fired: it is five times the size, so a single workspace
      // flooding from one address is always stopped here.
      expect(forwarded).toHaveLength(HOOK_WORKSPACE_BUCKET_MAX);
    });

    test("counts a workspace's deliveries whatever address they arrive from", async () => {
      const app = makeApp();
      await drive(app, SOURCE_A, goodPath(), HOOK_WORKSPACE_BUCKET_MAX + 1);

      // `SOURCE_B` has an untouched pre-token bucket, so a 429 here can only be
      // the post-token one — which is what makes the two keys distinguishable
      // rather than two counters that happen to move together.
      await expectRateLimited(await deliverFrom(app, SOURCE_B, goodPath()));
      expect(forwarded).toHaveLength(HOOK_WORKSPACE_BUCKET_MAX);
    });

    test("does not spend another workspace's allowance", async () => {
      const other = await store.create("Other Workspace");
      const otherId = newDeliveryId();
      await seedWorkspace({
        id: other.id,
        hooks: {
          [registrationKey(CONNECTOR, VENDOR)]: registration({
            idHash: deliveryIdHash(otherId),
          }),
        },
      });
      const app = makeApp();
      await drive(app, SOURCE_A, goodPath(), HOOK_WORKSPACE_BUCKET_MAX + 1);
      expect((await deliverFrom(app, SOURCE_A, goodPath())).status).toBe(429);

      // Same connector, same source, different workspace: a burst is meant to
      // fail against ONE workspace, which is the whole reason this bucket is
      // keyed the way it is rather than sitting per-tenant at the edge. The
      // workspace is now established by the LOOKUP rather than a sealed field,
      // so this also pins that the key the bucket is built from still comes out
      // of the registration the id resolved to.
      const res = await deliverFrom(app, SOURCE_A, goodPath(otherId));
      expect(res.status).toBe(202);
      expect(forwarded).toHaveLength(HOOK_WORKSPACE_BUCKET_MAX + 1);
    });

    test("admits again once its window has passed", async () => {
      const app = makeApp();
      const openedAt = Date.now();
      await drive(app, SOURCE_A, goodPath(), HOOK_WORKSPACE_BUCKET_MAX + 1);
      expect((await deliverFrom(app, SOURCE_A, goodPath())).status).toBe(429);

      setSystemTime(new Date(openedAt + HOOK_BUCKET_WINDOW_MS + 1_000));

      const res = await deliverFrom(app, SOURCE_A, goodPath());
      expect(res.status).toBe(202);
      expect(forwarded).toHaveLength(HOOK_WORKSPACE_BUCKET_MAX + 1);
    });
  });

  test("are the ones the server owns, when the route is built without overrides", async () => {
    // `startServer` constructs both so its `stop()` can clear their sweep
    // timers; a route that built its own would leave an interval alive past the
    // server and meter traffic on a bucket nothing else can see. Each bucket is
    // sized to one IN TURN, with the other left at full size: a single fixture
    // sized to one on only one of them pins that one and leaves the other free
    // to be self-constructed unnoticed.
    const appWithout = (over: Partial<AppContext>): Hono => {
      const routes = hooksRoutes(makeCtx(over), { identity: IDENTITY, fetchImpl: captureFetch });
      if (!routes) throw new Error("hooks routes should mount when an identity is supplied");
      return new Hono().route("/", routes);
    };

    const anon = appWithout({
      hookAnonLimiter: new RequestRateLimiter(1, HOOK_BUCKET_WINDOW_MS),
      hookWorkspaceLimiter: new RequestRateLimiter(HOOK_WORKSPACE_BUCKET_MAX, HOOK_BUCKET_WINDOW_MS),
    });
    expect((await deliverFrom(anon, SOURCE_A, goodPath())).status).toBe(202);
    await expectRateLimited(await deliverFrom(anon, SOURCE_A, goodPath()));

    const workspace = appWithout({
      hookAnonLimiter: new RequestRateLimiter(HOOK_ANON_BUCKET_MAX, HOOK_BUCKET_WINDOW_MS),
      hookWorkspaceLimiter: new RequestRateLimiter(1, HOOK_BUCKET_WINDOW_MS),
    });
    expect((await deliverFrom(workspace, SOURCE_B, goodPath())).status).toBe(202);
    await expectRateLimited(await deliverFrom(workspace, SOURCE_B, goodPath()));
  });
});

describe("what the door writes down", () => {
  test("never the delivery id, in any log line or response body", async () => {
    // Sharper than it was for a token. The id is the WHOLE capability — there is
    // no key it must also be paired with — so a log line carrying it hands a
    // working URL to every sink that reads the line. Both the admitted and the
    // refused path are driven, because a rejection is where an id is most
    // tempting to print.
    let bodies: string[] = [];
    await capturingLogs(async () => {
      const app = makeApp();
      const ok = await deliver(app, hookUrl());
      const bad = await deliver(app, hookUrl(UNKNOWN_ID));
      bodies = [await ok.text(), await bad.text()];
    });
    const everything = [...logLines, ...bodies].join("\n");
    expect(everything).not.toContain(DELIVERY_ID);
    expect(everything).not.toContain(UNKNOWN_ID);
    // Nor any leading run of one: a prefix narrows a guess, and the id is the
    // only secret there is.
    expect(everything).not.toContain(DELIVERY_ID.slice(0, 12));
    // The KEY id is still expected, and this line is the only place it appears
    // — it is the whole of rotation correlation, and it opens nothing.
    expect(logLines.join("\n")).toContain(KID);
  });

  test("never the body", async () => {
    const secret = "a-tenant-secret-that-must-not-be-logged";
    await capturingLogs(async () => {
      await deliver(makeApp(), hookUrl(), {
        body: JSON.stringify({ secret }),
      });
    });
    expect(logLines.join("\n")).not.toContain(secret);
  });
});

describe("when the connector cannot be reached", () => {
  test("the vendor gets a 502 so it retries", async () => {
    upstreamResponse = () => {
      throw new Error("connection refused");
    };
    const res = await deliver(makeApp(), hookUrl());
    expect(res.status).toBe(502);
  });
});

describe("a deployment with no hook key", () => {
  test("mounts nothing at all", () => {
    // An honest router 404 for the whole prefix, rather than a mounted route
    // that fails an internal config gate.
    expect(hooksRoutes(makeCtx(), { identity: undefined })).toBeNull();
  });
});

describe("the rotation overlap, at the door", () => {
  const OUTGOING_ID = newDeliveryId();

  /** The registration mid-rotation: a new id current, the outgoing one in grace. */
  async function midRotation(rotatedAt: string = new Date().toISOString()): Promise<void> {
    await seedWorkspace({
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({
          prevIdHash: deliveryIdHash(OUTGOING_ID),
          rotatedAt,
        }),
      },
    });
  }

  test("a URL minted under the outgoing id is still forwarded, and says so", async () => {
    // The whole point of the grace, exercised where a vendor actually meets it.
    // Pinned at the door rather than only at the function boundary because the
    // door is the line that decides whether an operator mid-rotation keeps
    // receiving — a vendor's queued redeliveries carry the OLD URL.
    await midRotation();
    let res!: Response;
    await capturingLogs(async () => {
      res = await deliver(makeApp(), hookUrl(OUTGOING_ID));
    });
    expect(res.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    // The exit condition, not decoration: the only evidence an operator has
    // that traffic still rides the outgoing URL. Retiring it blind is the
    // silent 404 the grace exists to prevent, so deleting this line must fail
    // a test rather than pass one.
    const superseded = logLines.filter((l) =>
      l.includes("delivery on a superseded delivery id"),
    );
    expect(superseded).toHaveLength(1);
  });

  test("a URL minted under the current id says nothing", async () => {
    // Silent in the steady state — a line on every delivery is noise no
    // operator reads, which is the same as having no signal at all.
    await midRotation();
    await capturingLogs(async () => {
      const res = await deliver(makeApp(), hookUrl());
      expect(res.status).toBe(202);
    });
    expect(logLines.join("\n")).not.toContain("delivery on a superseded delivery id");
  });

  test("the outgoing URL 404s once its grace window has passed", async () => {
    // The window closing is what retires the old URL. Nothing is deleted and no
    // operator acts — which is the difference from the key ring it replaces,
    // where retiring took a deliberate, irreversible drop.
    await midRotation(new Date(Date.now() - HOOK_ROTATION_GRACE_MS - 1_000).toISOString());
    const res = await deliver(makeApp(), hookUrl(OUTGOING_ID));
    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  test("an outgoing id is only admissible against the registration it rotated on", async () => {
    // A grace widens which id opens ONE registration, never which registrations
    // an id opens.
    await midRotation();
    const other = await store.create({ name: "other", ownerId: "usr_other" });
    await seedWorkspace({
      id: other.id,
      hooks: {
        [registrationKey(CONNECTOR, VENDOR)]: registration({ idHash: deliveryIdHash(newDeliveryId()) }),
      },
    });
    const res = await deliver(makeApp(), hookUrl(OUTGOING_ID));
    expect(res.status).toBe(202);
    // Forwarded once, on the rotating workspace's route — not twice, and not
    // the neighbour's.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toContain(ROUTE);
  });
});
