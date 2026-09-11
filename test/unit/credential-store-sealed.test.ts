/**
 * The file store with a sealer: what changes, and the one thing that must never
 * happen.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("with NO sealer configured, get throws rather than returning the bytes", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(); // deliberately no sealer
    try {
      seed(dir, "acme.key", sealed);
      await expect(store.get(WS, "acme.key", READ)).rejects.toThrow();
      // And specifically not this, which is the whole defect:
      const got = await store.get(WS, "acme.key", READ).catch(() => null);
      expect(got?.reveal()).not.toBe(sealed);
    } finally {
      cleanup();
    }
  });

  test("under a ring that does not hold its kid, get throws", async () => {
    const sealed = createCredentialSealer([KEY_A]).seal("workspace:ws_test", "acme.key", "s3cret");
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_B]));
    try {
      seed(dir, "acme.key", sealed);
      await expect(store.get(WS, "acme.key", READ)).rejects.toThrow(/cannot be opened/);
    } finally {
      cleanup();
    }
  });

  test("with a failed authentication tag, get throws", async () => {
    const sealer = createCredentialSealer([KEY_A]);
    const parts = sealer.seal("workspace:ws_test", "acme.key", "s3cret").split(".");
    const ct = Buffer.from(parts[4] as string, "base64url");
    ct[0] = (ct[0] as number) ^ 1;
    parts[4] = ct.toString("base64url");
    const { store, dir, cleanup } = fresh(sealer);
    try {
      seed(dir, "acme.key", parts.join("."));
      await expect(store.get(WS, "acme.key", READ)).rejects.toThrow(/failed authentication/);
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
        await expect(store.get(WS, "acme.key", READ)).rejects.toThrow();
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
      await store.get(WS, "acme.key", READ);
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
      await store.get(WS, "acme.key", READ).catch(() => null);
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
      await store.get(WS, "acme.key", READ).catch(() => null);
      expect(events[0]?.data).toMatchObject({ reason: "no_sealer", key: "acme.key" });
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
    // A deployment that turns sealing on keeps working before the boot sweep
    // has re-wrapped anything.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, "acme.key", "gw-from-store\n");
      expect((await store.get(WS, "acme.key", READ))?.reveal()).toBe("gw-from-store");
    } finally {
      cleanup();
    }
  });

  test("reading one does not rewrite it", async () => {
    // One write mechanism, the sweep's — not two. A read that sealed on the fly
    // would be a second migration path with different failure modes and no
    // audit line saying it ran.
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
