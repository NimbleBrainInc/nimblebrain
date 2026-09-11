import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../src/engine/types.ts";
import { DEFAULT_CREDENTIAL_STORE_BACKEND } from "../../src/config/secrets.ts";
import {
  _resetCredentialStoreBackendsForTest,
  type CredentialStoreBackend,
  createCredentialStore,
  getCredentialStoreBackend,
  registerBuiltinCredentialStoreBackends,
  registerCredentialStoreBackend,
  registeredCredentialStoreBackends,
} from "../../src/tools/credential-store-backend.ts";
import type { CredentialStore } from "../../src/tools/credential-store.ts";
import {
  describeCredentialStoreConformance,
  WS,
} from "../helpers/credential-store-conformance.ts";

// The default path is what a deployment with no `secrets` block gets, so the
// proof that PR 2 changed no behaviour is that it satisfies the same interface
// suite the concrete class does — not a spot check on one method.
function freshDefaultStore(): {
  store: CredentialStore;
  dir: string;
  events: EngineEvent[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-credbackend-"));
  const events: EngineEvent[] = [];
  registerBuiltinCredentialStoreBackends();
  const store = createCredentialStore({
    workDir: dir,
    eventSink: { emit: (e) => events.push(e) },
  });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describeCredentialStoreConformance("createCredentialStore (no secrets block)", freshDefaultStore);

// The interface suite, run a second time against a backend that holds
// ciphertext. This is what #1171's split was for: "a second backend runs the
// same suite" stops being aspirational the moment the same assertions pass over
// `NBS1.…` bytes. Nothing in the block below is sealing-aware, and that is the
// point — a caller of `CredentialStore` cannot tell which one answered.
const SEAL_KEY_ENV = "NB_TEST_CONFORMANCE_CREDENTIAL_KEY";
process.env[SEAL_KEY_ENV] = Buffer.alloc(32, 0x5a).toString("base64");

function freshSealedStore(): {
  store: CredentialStore;
  dir: string;
  events: EngineEvent[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-credbackend-sealed-"));
  const events: EngineEvent[] = [];
  registerBuiltinCredentialStoreBackends();
  const store = createCredentialStore({
    workDir: dir,
    eventSink: { emit: (e) => events.push(e) },
    secrets: { backend: "file", config: { seal: { keyEnv: SEAL_KEY_ENV } } },
  });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describeCredentialStoreConformance("createCredentialStore (sealed)", freshSealedStore);

describe("credential store backend registry", () => {
  afterEach(() => {
    _resetCredentialStoreBackendsForTest();
  });

  test("the built-in registration is `file`, and nothing else ships", () => {
    _resetCredentialStoreBackendsForTest();
    expect(registeredCredentialStoreBackends()).toEqual([]);
    registerBuiltinCredentialStoreBackends();
    expect(registeredCredentialStoreBackends()).toEqual(["file"]);
    expect(getCredentialStoreBackend("file")).toBeDefined();
  });

  test("re-registration overwrites — last writer wins", () => {
    const first: CredentialStoreBackend = { create: () => ({}) as CredentialStore };
    const second: CredentialStoreBackend = { create: () => ({}) as CredentialStore };
    registerCredentialStoreBackend("vault", first);
    registerCredentialStoreBackend("vault", second);
    expect(getCredentialStoreBackend("vault")).toBe(second);
  });

  test("the default backend name is `file`", () => {
    expect(DEFAULT_CREDENTIAL_STORE_BACKEND).toBe("file");
  });
});

describe("createCredentialStore", () => {
  afterEach(() => {
    _resetCredentialStoreBackendsForTest();
  });

  test("no secrets block and an explicit `file` reach the same backend", async () => {
    registerBuiltinCredentialStoreBackends();
    const dir = mkdtempSync(join(tmpdir(), "nb-credbackend-"));
    try {
      const implicit = createCredentialStore({ workDir: dir });
      await implicit.put(WS, "k", "v");
      // The file lands exactly where the plaintext file store has always put
      // it — the byte-identical-default claim, asserted on disk.
      const path = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k");
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const explicit = createCredentialStore({ workDir: dir, secrets: { backend: "file" } });
      expect((await explicit.get(WS, "k", { caller: "t", purpose: "t" }))?.reveal()).toBe("v");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unregistered backend throws at boot, naming the registered set", () => {
    registerBuiltinCredentialStoreBackends();
    expect(() =>
      createCredentialStore({ workDir: "/tmp/nb-unused", secrets: { backend: "vualt" } }),
    ).toThrow(/secrets\.backend "vualt" is not a registered backend.*Registered: file/s);
  });

  // Falling back to `file` here would hand a deployment that asked for a vault
  // a directory of plaintext files and no error. A typo is indistinguishable
  // from that at every later point, so the name has to be fatal.
  test("an unregistered backend does NOT fall back to the file store", () => {
    registerBuiltinCredentialStoreBackends();
    let built: CredentialStore | undefined;
    try {
      built = createCredentialStore({ workDir: "/tmp/nb-unused", secrets: { backend: "vault" } });
    } catch {
      // expected
    }
    expect(built).toBeUndefined();
  });

  test("the backend receives its own config verbatim, and `{}` when there is none", () => {
    const seen: Record<string, unknown>[] = [];
    registerCredentialStoreBackend("recording", {
      create({ config }) {
        seen.push(config);
        return {} as CredentialStore;
      },
    });
    createCredentialStore({ workDir: "/tmp/nb-unused", secrets: { backend: "recording" } });
    createCredentialStore({
      workDir: "/tmp/nb-unused",
      secrets: { backend: "recording", config: { seal: { keyEnv: "NB_CREDENTIAL_KEY" } } },
    });
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual({ seal: { keyEnv: "NB_CREDENTIAL_KEY" } });
  });

  test("the backend receives the work directory and the event sink", () => {
    let ctx: { workDir: string; eventSink?: unknown } | undefined;
    const sink = { emit: () => {} };
    registerCredentialStoreBackend("recording", {
      create(received) {
        ctx = received;
        return {} as CredentialStore;
      },
    });
    createCredentialStore({
      workDir: "/tmp/nb-workdir",
      eventSink: sink,
      secrets: { backend: "recording" },
    });
    expect(ctx?.workDir).toBe("/tmp/nb-workdir");
    expect(ctx?.eventSink).toBe(sink);
  });
});
