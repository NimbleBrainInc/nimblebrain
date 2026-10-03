/**
 * The two credential-store states that must reach an alert: a secret that failed
 * to open, re-seal, or was refused, and a sealing store still accepting
 * plaintext. Both flow from the store's own events through `MetricsEventSink`,
 * so the store never imports the metrics module.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsEventSink } from "../../src/adapters/metrics-events.ts";
import {
  credentialSealFailuresTotal,
  credentialStorePlaintextAccepted,
  credentialStoreSealed,
} from "../../src/api/metrics.ts";
import { type CredentialSealer, createCredentialSealer } from "../../src/tools/credential-seal.ts";
import {
  FileCredentialStore,
  SEAL_FAILURE_REASONS,
  type SealFailureReason,
} from "../../src/tools/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

const KEY_A = Buffer.alloc(32, 0x11);
const WS_SECRETS = ["workspaces", "ws_0076759dbbe19fcc", "credentials", "secrets"];

// Deltas, not resets: the registry is process-global and other files touch it.
async function failures(reason: string): Promise<number> {
  const metric = await credentialSealFailuresTotal.get();
  return metric.values.find((s) => s.labels.reason === reason)?.value ?? 0;
}

async function plaintextAccepted(): Promise<number> {
  const metric = await credentialStorePlaintextAccepted.get();
  return metric.values[0]?.value ?? 0;
}

async function sealed(): Promise<number> {
  const metric = await credentialStoreSealed.get();
  return metric.values[0]?.value ?? 0;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  credentialStorePlaintextAccepted.set(0);
  credentialStoreSealed.set(0);
});

function fresh(sealer?: CredentialSealer) {
  const dir = mkdtempSync(join(tmpdir(), "nb-cred-metrics-"));
  seedWorkspaceRoot(dir, "ws_0076759dbbe19fcc");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileCredentialStore(dir, {
    eventSink: new MetricsEventSink(),
    ...(sealer ? { sealer } : {}),
  });
  const seed = (key: string, contents: string) => {
    const secretsDir = join(dir, ...WS_SECRETS);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDir, key), contents, { mode: 0o600 });
  };
  return { store, seed };
}

describe("nb_credential_seal_failures_total", () => {
  test("every reason has a series before its first failure", async () => {
    // A series born at 1 reads as no change to increase(); one that exists at 0
    // makes the first failure after boot an increase.
    const metric = await credentialSealFailuresTotal.get();
    const present = new Set(metric.values.map((s) => s.labels.reason));
    for (const reason of Object.keys(SEAL_FAILURE_REASONS)) expect(present.has(reason)).toBe(true);
  });

  test("one increment per audit event, under its own reason", async () => {
    const sink = new MetricsEventSink();
    const before = {
      skipped: await failures("reseal_skipped"),
      kid: await failures("unknown_kid"),
    };
    const emit = (reason: SealFailureReason) =>
      sink.emit({
        type: "audit.credential_seal_failure",
        data: { scope: "workspace:ws_0076759dbbe19fcc", key: "acme.key", reason },
      });
    emit("reseal_skipped");
    emit("reseal_skipped");
    emit("unknown_kid");
    expect((await failures("reseal_skipped")) - before.skipped).toBe(2);
    expect((await failures("unknown_kid")) - before.kid).toBe(1);
  });

  test("a sweep over a planted sealed-looking file counts it", async () => {
    const { store, seed } = fresh(createCredentialSealer([KEY_A]));
    seed("good.one", "v1");
    seed("planted.key", "NBS1.x");
    const before = await failures("reseal_skipped");
    await store.reconcile?.();
    expect((await failures("reseal_skipped")) - before).toBe(1);
  });

  test("a plaintext file refused after a clean sweep counts as plaintext_refused", async () => {
    const { store, seed } = fresh(createCredentialSealer([KEY_A]));
    seed("good.one", "v1");
    await store.reconcile?.();
    seed("injected.key", "attacker-chosen");
    const before = await failures("plaintext_refused");
    const got = await store.get(
      { kind: "workspace", wsId: "ws_0076759dbbe19fcc" },
      "injected.key",
      {
        caller: "test",
        purpose: "unit test",
      },
    );
    expect(() => got?.reveal()).toThrow(/plaintext/);
    expect((await failures("plaintext_refused")) - before).toBe(1);
  });
});

describe("nb_credential_store_plaintext_accepted", () => {
  test("1 for a sealing store whose sweep held strict mode off", async () => {
    // Plaintext that could not be re-sealed is a legitimate secret still on disk.
    const working = createCredentialSealer([KEY_A]);
    const failing: CredentialSealer = {
      ...working,
      seal: () => {
        throw new Error("seal failed");
      },
    };
    const { store, seed } = fresh(failing);
    seed("legacy.key", "still-readable");
    await store.reconcile?.();
    expect(await plaintextAccepted()).toBe(1);
  });

  test("0 after a clean sweep", async () => {
    credentialStorePlaintextAccepted.set(1);
    const { store, seed } = fresh(createCredentialSealer([KEY_A]));
    seed("legacy.key", "v1");
    await store.reconcile?.();
    expect(await plaintextAccepted()).toBe(0);
  });

  test("0 for a store with no sealing key, which accepts plaintext by design", async () => {
    credentialStorePlaintextAccepted.set(1);
    const { store, seed } = fresh();
    seed("legacy.key", "v1");
    await store.reconcile?.();
    expect(await plaintextAccepted()).toBe(0);
  });
});

describe("nb_credential_store_sealed", () => {
  test("1 for a store with a sealing key", async () => {
    const { store } = fresh(createCredentialSealer([KEY_A]));
    await store.reconcile?.();
    expect(await sealed()).toBe(1);
  });

  test("0 for a store with no sealing key", async () => {
    credentialStoreSealed.set(1);
    const { store } = fresh();
    await store.reconcile?.();
    expect(await sealed()).toBe(0);
  });
});

describe("labels", () => {
  // A key name discloses which vendors a tenant uses, and a workspace or user id
  // is unbounded. The audit log says where; the metric says only why.
  test("reason is the only label on any series", async () => {
    new MetricsEventSink().emit({
      type: "audit.credential_seal_failure",
      data: {
        scope: "workspace:ws_0076759dbbe19fcc",
        key: "acme.key",
        reason: "auth_failed",
        wantedKid: "0123456789abcdef",
        workspaceId: "ws_0076759dbbe19fcc",
      },
    });
    new MetricsEventSink().emit({
      type: "credential_store.reconciled",
      data: { sealed: true, strictPlaintextRefusal: false },
    });
    const counter = await credentialSealFailuresTotal.get();
    expect(counter.values.length).toBeGreaterThan(0);
    for (const s of counter.values) expect(Object.keys(s.labels)).toEqual(["reason"]);
    for (const g of [credentialStorePlaintextAccepted, credentialStoreSealed]) {
      const gauge = await g.get();
      expect(gauge.values.length).toBeGreaterThan(0);
      for (const s of gauge.values) expect(Object.keys(s.labels)).toEqual([]);
    }
  });
});
