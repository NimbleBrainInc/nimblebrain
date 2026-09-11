/**
 * The file store with a sealer: what changes, and the one thing that must never
 * happen.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLogSink } from "../../src/adapters/workspace-log-sink.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import {
  createCredentialSealer,
  type CredentialSealer,
} from "../../src/tools/credential-seal.ts";
import {
  createCredentialStore,
  registerBuiltinCredentialStoreBackends,
  runSealCanary,
} from "../../src/tools/credential-store-backend.ts";
import { type CredentialScope, FileCredentialStore } from "../../src/tools/credential-store.ts";

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

const WS: CredentialScope = { kind: "workspace", wsId: "ws_test" };
const READ = { caller: "test", purpose: "unit test" };

function fresh(sealer?: CredentialSealer) {
  const dir = mkdtempSync(join(tmpdir(), "nb-sealed-"));
  const events: EngineEvent[] = [];
  const store = new FileCredentialStore(dir, {
    eventSink: { emit: (e) => events.push(e) },
    ...(sealer ? { sealer } : {}),
  });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Hand-seed a file the way an operator does, bypassing the store entirely. */
function seed(dir: string, key: string, contents: string): string {
  const secretsDir = join(dir, "workspaces", "ws_test", "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const path = join(secretsDir, key);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

// ── The regression that matters most ─────────────────────────────────
//
// Without this, removing `secrets.config.seal` — or rolling the image back
// below the release that introduced sealing — turns every sealed file into a
// "plaintext" read that hands `NBS1.…` to a vendor as an API key. Silently, for
// every credential, and precisely during the incident that caused it. Rollback
// is exactly when it fires, which is why it is the first test in this file.

describe("a value that claims to be sealed is never read as plaintext", () => {
  test("with NO sealer configured, reveal throws rather than returning the bytes", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(); // deliberately no sealer
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();
      // And specifically not this, which is the whole defect:
      let revealed: string | undefined;
      try {
        revealed = got?.reveal();
      } catch {
        // expected
      }
      expect(revealed).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("under a ring that does not hold its kid, reveal throws", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow(/cannot be opened/);
    } finally {
      cleanup();
    }
  });

  test("with a failed authentication tag, reveal throws", async () => {
    const sealer = createCredentialSealer([KEY_A]);
    const parts = sealer.seal("workspace:ws_test", "acme.key", "s3cret").split(".");
    const ct = Buffer.from(parts[4] as string, "base64url");
    ct[0] = (ct[0] as number) ^ 1;
    parts[4] = ct.toString("base64url");
    const { store, dir, cleanup } = fresh(sealer);
    try {
      seed(dir, "acme.key", parts.join("."));
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow(/failed authentication/);
    } finally {
      cleanup();
    }
  });

  test("a sealed file damaged out of its grammar still throws, rather than falling through", async () => {
    // The gap the magic-only discriminator closes: `echo` adds a newline, a
    // truncated write cuts a field, and under a full-grammar gate every one of
    // these would read as legacy plaintext and be handed out AS the credential.
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    for (const damaged of [`${sealed}\n`, `${sealed} `, sealed.slice(0, -4), "NBS1."]) {
      const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
      try {
        seed(dir, "acme.key", damaged);
        const got = await store.get(WS, "acme.key", READ);
        expect(() => got?.reveal()).toThrow();
      } finally {
        cleanup();
      }
    }
  });

  test("the error names the key, the scope and the wanted kid", async () => {
    const sealer = createCredentialSealer([KEY_A]);
    const sealed = sealer.seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      (await store.get(WS, "acme.key", READ))?.reveal();
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      // "wrong key" has to be distinguishable from "corrupt file" without
      // anyone reading the file.
      expect(message).toContain("acme.key");
      expect(message).toContain("workspace:ws_test");
      expect(message).toContain(sealer.sealingKid);
    } finally {
      cleanup();
    }
  });

  test("a failed open is audited — scope, key, reason, kid, never a value", async () => {
    const sealer = createCredentialSealer([KEY_A]);
    const sealed = sealer.seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "audit.credential_seal_failure",
        data: {
          scope: "workspace:ws_test",
          key: "acme.key",
          reason: "unknown_kid",
          wantedKid: sealer.sealingKid,
          workspaceId: "ws_test",
        },
      });
      // The bytes that failed to open are still a live credential's ciphertext.
      expect(JSON.stringify(events)).not.toContain(sealed);
    } finally {
      cleanup();
    }
  });

  test("no sealer configured is audited as its own reason", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, events, cleanup } = fresh();
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();
      expect(events[0]?.data).toMatchObject({ reason: "no_sealer", key: "acme.key" });
    } finally {
      cleanup();
    }
  });
});

describe("a presence probe never opens anything", () => {
  // `get` without a `reveal` is how the runtime asks whether a secret EXISTS:
  // connection-state derivation runs it over every installed connector on a page
  // load, and boot runs it over every URL connector before starting any of them.
  // Opening eagerly made one unopenable value throw at all of those — so a
  // single bad secret failed the whole tenant's boot and hid the UI that would
  // repair it. The failure belongs on the connection that uses the secret.

  test("an unopenable value is still probeable — get resolves, reveal throws", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(got).not.toBeNull(); // the probe answers "set"
      expect(() => got?.reveal()).toThrow(/cannot be opened/);
    } finally {
      cleanup();
    }
  });

  test("a probe over a mix of good and bad values reaches every one", async () => {
    // The boot shape: one connector's record is unopenable and the healthy ones
    // must still start.
    const sealer = createCredentialSealer([KEY_A]);
    const { store, dir, cleanup } = fresh(sealer);
    try {
      await store.put(WS, "good.one", "v1");
      seed(dir, "bad.one", createCredentialSealer([KEY_B]).seal("workspace:ws_test", "bad.one", "x"));
      await store.put(WS, "good.two", "v2");
      const probes = await Promise.all(
        ["good.one", "bad.one", "good.two"].map((k) => store.get(WS, k, READ)),
      );
      expect(probes.every((p) => p !== null)).toBe(true);
      expect(probes[0]?.reveal()).toBe("v1");
      expect(probes[2]?.reveal()).toBe("v2");
    } finally {
      cleanup();
    }
  });

  test("a probe that never reveals writes no audit line at all", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      await store.get(WS, "acme.key", READ);
      // Not even the failure: nothing was attempted, so nothing failed.
      expect(events).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("revealing twice audits the failure once", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();
      expect(() => got?.reveal()).toThrow();
      expect(events).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("a failed open writes no credential_read line", async () => {
    // It was not revealed. A log saying it was would be false in the one
    // direction that matters.
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();
      expect(events.map((e) => e.type)).toEqual(["audit.credential_seal_failure"]);
    } finally {
      cleanup();
    }
  });

  test("a redacted unopenable value still prints as [redacted]", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(`${got}`).toBe("[redacted]");
      expect(JSON.stringify({ got })).not.toContain("NBS1");
    } finally {
      cleanup();
    }
  });
});

describe("each way an open can fail says which one it was", () => {
  // Collapsing these makes a stray trailing newline read as a wrong key, and
  // sends an operator to rotate a key that was never the problem.
  const cases: [string, string, RegExp][] = [
    ["a kid the ring does not hold", "unknown_kid", /Load the key that did/],
    ["bytes that fail the tag", "auth_failed", /failed authentication/],
    ["a value damaged out of its grammar", "malformed", /not a well-formed sealed value/],
  ];

  test.each(cases)("%s is reported as %s", async (_label, reason, remedy) => {
    const sealer = createCredentialSealer([KEY_A]);
    const sealed = sealer.seal("workspace:ws_test", "acme.key", "s3cret");
    let onDisk = sealed;
    let ring = sealer;
    if (reason === "unknown_kid") {
      ring = createCredentialSealer([KEY_B]);
    } else if (reason === "auth_failed") {
      const parts = sealed.split(".");
      const ct = Buffer.from(parts[4] as string, "base64url");
      ct[0] = (ct[0] as number) ^ 1;
      parts[4] = ct.toString("base64url");
      onDisk = parts.join(".");
    } else {
      onDisk = `${sealed}\n`;
    }
    const { store, dir, events, cleanup } = fresh(ring);
    try {
      seed(dir, "acme.key", onDisk);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow(remedy);
      expect(events[0]?.data.reason).toBe(reason);
    } finally {
      cleanup();
    }
  });
});

describe("what is on disk", () => {
  test("the file holds ciphertext, not the secret", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.put(WS, "acme.key", "s3cret-value");
      const raw = readFileSync(
        join(dir, "workspaces", "ws_test", "credentials", "secrets", "acme.key"),
        "utf-8",
      );
      expect(raw).not.toContain("s3cret-value");
      expect(raw.startsWith("NBS1.")).toBe(true);
      expect(raw).not.toContain("\n");
    } finally {
      cleanup();
    }
  });

  test("the file mechanics do not change", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.put(WS, "k1", "v1");
      const path = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k1");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "workspaces", "ws_test", "credentials", "secrets")).mode & 0o777)
        .toBe(0o700);
    } finally {
      cleanup();
    }
  });

  test("two puts of one value leave different bytes", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      const path = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k");
      await store.put(WS, "k", "identical");
      const first = readFileSync(path, "utf-8");
      await store.put(WS, "k", "identical");
      expect(readFileSync(path, "utf-8")).not.toBe(first);
    } finally {
      cleanup();
    }
  });
});

describe("the trailing newline splits", () => {
  // `credential-store.ts` trims one trailing newline from an unsealed file, an
  // affordance for `echo "secret" > file`. It is lossy and always has been: a
  // value that genuinely ends in a newline comes back without it, and the
  // plaintext path cannot tell the two cases apart. Sealed bytes carry their own
  // length, so sealing is what fixes it.

  test("legacy: a hand-seeded plaintext file is trimmed", async () => {
    const { store, dir, cleanup } = fresh();
    try {
      seed(dir, "k", "value\n");
      expect((await store.get(WS, "k", READ))?.reveal()).toBe("value");
    } finally {
      cleanup();
    }
  });

  test("sealed: a value round-trips byte-exact, newline and all", async () => {
    const { store, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      for (const value of ["value\n", "\n", "a\nb\n\n", " padded ", ""]) {
        await store.put(WS, "k", value);
        expect((await store.get(WS, "k", READ))?.reveal()).toBe(value);
      }
    } finally {
      cleanup();
    }
  });
});

describe("legacy plaintext under a sealer", () => {
  test("a hand-seeded plaintext file is still read", async () => {
    // A deployment that turns sealing on keeps working on the files already
    // there; each becomes sealed when something next writes it.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, "acme.key", "gw-from-store\n");
      expect((await store.get(WS, "acme.key", READ))?.reveal()).toBe("gw-from-store");
    } finally {
      cleanup();
    }
  });

  test("reading one does not rewrite it", async () => {
    // A read that sealed on the fly would be a write nobody asked for, on the
    // path that runs most often, with no audit line saying it ran.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      const path = seed(dir, "acme.key", "gw-from-store");
      await store.get(WS, "acme.key", READ);
      expect(readFileSync(path, "utf-8")).toBe("gw-from-store");
    } finally {
      cleanup();
    }
  });
});

describe("the boot canary", () => {
  test("a ring that round-trips passes", () => {
    expect(() => runSealCanary(createCredentialSealer([KEY_A]), "NB_TEST_KEY")).not.toThrow();
  });

  test("a sealer that does not round-trip fails loudly, naming the variable", () => {
    const broken: CredentialSealer = {
      sealingKid: "0".repeat(16),
      kids: ["0".repeat(16)],
      seal: () => "NBS1.0000000000000000.AAAA.BBBB.CCCC",
      open: () => "not-the-canary",
    };
    expect(() => runSealCanary(broken, "NB_TEST_KEY")).toThrow(/NB_TEST_KEY.*does not round-trip/s);
  });

  test("a sealer that throws on open fails loudly too", () => {
    const broken: CredentialSealer = {
      sealingKid: "0".repeat(16),
      kids: ["0".repeat(16)],
      seal: () => "NBS1.0000000000000000.AAAA.BBBB.CCCC",
      open: () => {
        throw new Error("cipher unavailable");
      },
    };
    expect(() => runSealCanary(broken, "NB_TEST_KEY")).toThrow(/does not round-trip/);
  });
});

describe("selecting the sealing backend from config", () => {
  const ENV = "NB_TEST_CREDENTIAL_KEY";

  function build(config: Record<string, unknown>, env?: string) {
    registerBuiltinCredentialStoreBackends();
    const dir = mkdtempSync(join(tmpdir(), "nb-sealed-cfg-"));
    const previous = process.env[ENV];
    if (env === undefined) delete process.env[ENV];
    else process.env[ENV] = env;
    try {
      return { store: createCredentialStore({ workDir: dir, secrets: { config } }), dir };
    } finally {
      if (previous === undefined) delete process.env[ENV];
      else process.env[ENV] = previous;
    }
  }

  test("no seal block is the default, and the file holds the secret verbatim", async () => {
    const { store, dir } = build({});
    try {
      await store.put(WS, "k", "plain");
      const raw = readFileSync(
        join(dir, "workspaces", "ws_test", "credentials", "secrets", "k"),
        "utf-8",
      );
      expect(raw).toBe("plain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a seal block whose variable is unset is FATAL, not a fallback", () => {
    // The same refusal an unknown backend name gets, for the same reason: a
    // deployment that asked to be sealed and silently got plaintext files is
    // the worst outcome available.
    expect(() => build({ seal: { keyEnv: ENV } }, undefined)).toThrow(/unset or empty/);
    expect(() => build({ seal: { keyEnv: ENV } }, "")).toThrow(/unset or empty/);
  });

  test("a malformed seal block is refused", () => {
    expect(() => build({ seal: {} })).toThrow(/keyEnv must name an environment variable/);
    expect(() => build({ seal: { keyEnv: 42 } })).toThrow(/keyEnv must name/);
    expect(() => build({ seal: "NB_TEST_CREDENTIAL_KEY" })).toThrow(/must be an object/);
  });

  test("a ring the parse rejects fails at create", () => {
    expect(() => build({ seal: { keyEnv: ENV } }, Buffer.alloc(31, 1).toString("base64"))).toThrow(
      />= 32 bytes/,
    );
  });

  test("a valid seal block produces a store that writes ciphertext", async () => {
    const { store, dir } = build({ seal: { keyEnv: ENV } }, KEY_A.toString("base64"));
    try {
      await store.put(WS, "k", "s3cret");
      const raw = readFileSync(
        join(dir, "workspaces", "ws_test", "credentials", "secrets", "k"),
        "utf-8",
      );
      expect(raw.startsWith("NBS1.")).toBe(true);
      expect((await store.get(WS, "k", READ))?.reveal()).toBe("s3cret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the failure reaches a real sink, not just a test array", () => {
  // Every other test in this file captures events into an in-memory array, which
  // proves the store emits and nothing about whether anything records it. The
  // workspace log has an allowlist, and an event type missing from it is dropped
  // silently — so an audit event nobody writes down is the same as no audit
  // event, and no in-memory assertion can tell the difference.
  test("a failed open is written to the workspace log", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "nb-sealed-log-"));
    const dir = mkdtempSync(join(tmpdir(), "nb-sealed-"));
    try {
      const store = new FileCredentialStore(dir, {
        eventSink: new WorkspaceLogSink({ dir: logDir }),
        sealer: createCredentialSealer([KEY_B]),
      });
      const sealed = createCredentialSealer([KEY_A]).seal(
        "workspace:ws_test",
        "acme.key",
        "s3cret",
      );
      seed(dir, "acme.key", sealed);
      const got = await store.get(WS, "acme.key", READ);
      expect(() => got?.reveal()).toThrow();

      const files = readdirSync(join(logDir, "workspace"));
      const written = readFileSync(join(logDir, "workspace", files[0] as string), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string });
      expect(written.map((r) => r.event)).toEqual(["audit.credential_seal_failure"]);
      expect(JSON.stringify(written)).not.toContain(sealed);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
