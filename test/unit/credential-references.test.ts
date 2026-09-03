/**
 * Credential references in config — the acceptance surface of the secrets door.
 *
 * Three questions, in order of how much they'd cost to get wrong:
 *   1. does a `{ ref: "credential" }` in a transport header reach the wire as the
 *      workspace's secret, and does the literal form still work;
 *   2. does a missing key fail loudly, naming the key and the scope, instead of
 *      sending a blank header;
 *   3. does a `put` on the same key rotate it — no restart, no config edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTransportConfig } from "../../src/bundles/types.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import {
  _resetCredentialStoreForTest,
  FileCredentialStore,
  setCredentialStore,
} from "../../src/tools/credential-store.ts";
import { resolveInstanceCredentialRefs } from "../../src/tools/instance-credentials.ts";
import { resolveTransportCredential } from "../../src/tools/remote-transport.ts";

const WS_ID = "ws_acme01";
let workDir: string;
let store: FileCredentialStore;
let events: EngineEvent[];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-credref-"));
  events = [];
  store = new FileCredentialStore(workDir, { eventSink: { emit: (e) => events.push(e) } });
  setCredentialStore(store);
});

afterEach(() => {
  _resetCredentialStoreForTest();
  rmSync(workDir, { recursive: true, force: true });
});

describe("transport auth — literal and reference", () => {
  test("a bearer token given literally still reaches the header", async () => {
    const config: RemoteTransportConfig = { auth: { type: "bearer", token: "literal-token" } };
    const { headers } = await resolveTransportCredential(config, WS_ID);
    expect(headers.Authorization).toBe("Bearer literal-token");
  });

  test("a bearer token given as a reference resolves from the workspace's store", async () => {
    await store.put({ kind: "workspace", wsId: WS_ID }, "acme.db_url", "stored-token");
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    const { headers } = await resolveTransportCredential(config, WS_ID);
    expect(headers.Authorization).toBe("Bearer stored-token");
  });

  test("a named header's value resolves the same way", async () => {
    await store.put({ kind: "workspace", wsId: WS_ID }, "acme.api_key", "k_stored");
    const config: RemoteTransportConfig = {
      auth: { type: "header", name: "x-api-key", value: { ref: "credential", key: "acme.api_key" } },
    };
    const { headers } = await resolveTransportCredential(config, WS_ID);
    expect(headers["x-api-key"]).toBe("k_stored");
  });

  test("an arbitrary header may be a reference too", async () => {
    await store.put({ kind: "workspace", wsId: WS_ID }, "acme.trace", "t_stored");
    const config: RemoteTransportConfig = {
      headers: { "x-trace": { ref: "credential", key: "acme.trace" }, "x-plain": "kept" },
    };
    const { headers } = await resolveTransportCredential(config, WS_ID);
    expect(headers).toEqual({ "x-trace": "t_stored", "x-plain": "kept" });
  });

  test("`${VAR}` no longer resolves anywhere — it is sent verbatim", async () => {
    process.env.NB_CREDREF_PROBE = "from-env";
    try {
      const config: RemoteTransportConfig = {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal that must NOT expand
        auth: { type: "bearer", token: "${NB_CREDREF_PROBE}" },
      };
      const { headers } = await resolveTransportCredential(config, WS_ID);
      expect(headers.Authorization).toBe("Bearer ${NB_CREDREF_PROBE}");
    } finally {
      delete process.env.NB_CREDREF_PROBE;
    }
  });
});

describe("the same reference means a different secret per workspace", () => {
  // The property a fleet service depends on: one catalog entry, two workspaces,
  // two secrets. If scope leaked, one tenant would authenticate as another.
  test("two workspaces with the same key each send their own value", async () => {
    await store.put({ kind: "workspace", wsId: "ws_tenanta" }, "acme.db_url", "a-secret");
    await store.put({ kind: "workspace", wsId: "ws_tenantb" }, "acme.db_url", "b-secret");
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    expect((await resolveTransportCredential(config, "ws_tenanta")).headers.Authorization).toBe(
      "Bearer a-secret",
    );
    expect((await resolveTransportCredential(config, "ws_tenantb")).headers.Authorization).toBe(
      "Bearer b-secret",
    );
  });
});

describe("failure is loud and names the cause", () => {
  test("a missing key throws with the key and the scope", async () => {
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    await expect(resolveTransportCredential(config, WS_ID)).rejects.toThrow(
      /acme\.db_url.*workspace:ws_acme01/s,
    );
  });

  test("a reference with no workspace in scope is refused, not resolved elsewhere", async () => {
    await store.put({ kind: "instance" }, "acme.db_url", "instance-secret");
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    // An instance-scope value with the same key exists; falling back to it would
    // hand a connection the operator's credential.
    await expect(resolveTransportCredential(config, undefined)).rejects.toThrow(/no workspace/);
  });
});

describe("rotation", () => {
  test("a put on the same key takes effect on the next resolve — no restart, no config edit", async () => {
    const scope = { kind: "workspace", wsId: WS_ID } as const;
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    await store.put(scope, "acme.db_url", "v1");
    expect((await resolveTransportCredential(config, WS_ID)).headers.Authorization).toBe(
      "Bearer v1",
    );
    await store.put(scope, "acme.db_url", "v2");
    expect((await resolveTransportCredential(config, WS_ID)).headers.Authorization).toBe(
      "Bearer v2",
    );
  });

  test("deleting the key breaks the next connection loudly rather than silently", async () => {
    const scope = { kind: "workspace", wsId: WS_ID } as const;
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    await store.put(scope, "acme.db_url", "v1");
    await store.delete(scope, "acme.db_url");
    await expect(resolveTransportCredential(config, WS_ID)).rejects.toThrow(/acme\.db_url/);
  });
});

describe("audit", () => {
  test("resolving a header reference is visible in the event log, without the value", async () => {
    await store.put({ kind: "workspace", wsId: WS_ID }, "acme.db_url", "supersecret");
    const config: RemoteTransportConfig = {
      auth: { type: "bearer", token: { ref: "credential", key: "acme.db_url" } },
    };
    await resolveTransportCredential(config, WS_ID);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("audit.credential_read");
    expect(events[0]?.data).toMatchObject({
      scope: "workspace:ws_acme01",
      key: "acme.db_url",
      caller: "transport:header",
    });
    expect(JSON.stringify(events)).not.toContain("supersecret");
  });

  test("a literal token produces no audit line — there is no store read to attribute", async () => {
    await resolveTransportCredential({ auth: { type: "bearer", token: "literal" } }, WS_ID);
    expect(events).toEqual([]);
  });
});

describe("instance config references", () => {
  test("a provider key resolves from the instance scope and the config path is the purpose", async () => {
    await store.put({ kind: "instance" }, "anthropic.key", "sk-stored");
    const resolved = await resolveInstanceCredentialRefs({
      providers: { anthropic: { apiKey: { ref: "credential", key: "anthropic.key" } } },
    });
    expect(resolved.providers.anthropic.apiKey).toBe("sk-stored");
    expect(events[0]?.data).toMatchObject({
      scope: "instance",
      key: "anthropic.key",
      caller: "config:instance",
      purpose: "providers.anthropic.apiKey",
    });
  });

  test("a gateway key under an operator-chosen name resolves without being named in code", async () => {
    await store.put({ kind: "instance" }, "acme.gateway_key", "gw-stored");
    const resolved = await resolveInstanceCredentialRefs({
      connectors: { gateways: { acme: { apiKey: { ref: "credential", key: "acme.gateway_key" } } } },
    });
    expect(resolved.connectors.gateways.acme.apiKey).toBe("gw-stored");
  });

  test("a config with no references comes back as the very same object", async () => {
    const config = { providers: { anthropic: { apiKey: "sk-literal" } }, maxIterations: 5 };
    expect(await resolveInstanceCredentialRefs(config)).toBe(config);
  });

  test("live objects in the config keep their identity and are never descended into", async () => {
    // `RuntimeConfig` carries an `events: EventSink[]` and a `confirmationGate`;
    // rebuilding either as a plain object would strip its prototype.
    class Sink {
      emit(): void {}
    }
    const sink = new Sink();
    await store.put({ kind: "instance" }, "k", "v");
    const config = {
      events: [sink],
      providers: { anthropic: { apiKey: { ref: "credential", key: "k" } } },
    };
    const resolved = await resolveInstanceCredentialRefs(config);
    expect(resolved.providers.anthropic.apiKey).toBe("v");
    expect(resolved.events[0]).toBe(sink);
    expect(resolved.events[0]).toBeInstanceOf(Sink);
  });

  test("a reference to a key with no value fails at boot, naming the key", async () => {
    await expect(
      resolveInstanceCredentialRefs({
        connectors: { providers: { composio: { apiKey: { ref: "credential", key: "absent" } } } },
      }),
    ).rejects.toThrow(/absent.*instance/s);
  });
});
