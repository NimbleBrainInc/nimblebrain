/**
 * The boot re-seal sweep, and the strict mode a clean one turns on.
 *
 * Four properties, each with a failure an operator would actually meet:
 * idempotence (every boot after the first), non-fatal per file (one bad secret
 * must not take a tenant down), mtime preservation (or `list` starts reporting
 * "last sealed" as "last set"), and the plaintext refusal that makes sealing
 * buy integrity as well as confidentiality.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../src/engine/types.ts";
import {
  createCredentialSealer,
  type CredentialSealer,
  parseSealedValue,
} from "../../src/tools/credential-seal.ts";
import { type CredentialScope, FileCredentialStore } from "../../src/tools/credential-store.ts";

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

const WS: CredentialScope = { kind: "workspace", wsId: "ws_test" };
const INSTANCE: CredentialScope = { kind: "instance" };
const USER: CredentialScope = { kind: "user", userId: "usr_alex01" };
const READ = { caller: "test", purpose: "unit test" };

function fresh(sealer?: CredentialSealer) {
  const dir = mkdtempSync(join(tmpdir(), "nb-reseal-"));
  const events: EngineEvent[] = [];
  const store = new FileCredentialStore(dir, {
    eventSink: { emit: (e) => events.push(e) },
    ...(sealer ? { sealer } : {}),
  });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SCOPE_DIRS: [CredentialScope, string[]][] = [
  [INSTANCE, ["credentials", "secrets"]],
  [WS, ["workspaces", "ws_test", "credentials", "secrets"]],
  [USER, ["users", "usr_alex01", "credentials", "secrets"]],
];

/** Hand-seed a file, bypassing the store — how every secret got there before. */
function seed(dir: string, segments: string[], key: string, contents: string): string {
  const secretsDir = join(dir, ...segments);
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const path = join(secretsDir, key);
  // Synchronous on purpose: `Bun.write` returns a promise, and an unawaited one
  // here is a file that may not exist when the sweep walks the directory.
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function readRaw(dir: string, segments: string[], key: string): string {
  return readFileSync(join(dir, ...segments, key), "utf-8");
}

describe("the sweep converts what is already there", () => {
  test("plaintext becomes sealed, in all three scopes", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      for (const [, segments] of SCOPE_DIRS) {
        seed(dir, segments, "acme.key", "s3cret");
      }
      await store.reconcile?.();
      for (const [scope, segments] of SCOPE_DIRS) {
        expect(readRaw(dir, segments, "acme.key").startsWith("NBS1.")).toBe(true);
        expect((await store.get(scope, "acme.key", READ))?.reveal()).toBe("s3cret");
      }
    } finally {
      cleanup();
    }
  });

  test("a value sealed under an older key is re-wrapped under the current one", async () => {
    // The rotation seam: prepend a key, restart, and this runs on the way up
    // while the outgoing key still opens what it has not reached.
    const outgoing = createCredentialSealer([KEY_B]);
    const rotated = createCredentialSealer([KEY_A, KEY_B]);
    const { store, dir, cleanup } = fresh(rotated);
    try {
      seed(dir, SCOPE_DIRS[1][1], "acme.key", outgoing.seal("workspace:ws_test", "acme.key", "v"));
      await store.reconcile?.();
      const raw = readRaw(dir, SCOPE_DIRS[1][1], "acme.key");
      expect(parseSealedValue(raw)?.kid).toBe(rotated.sealingKid);
      expect((await store.get(WS, "acme.key", READ))?.reveal()).toBe("v");
    } finally {
      cleanup();
    }
  });

  test("the trailing newline of a hand-seeded file is trimmed, once", async () => {
    // `echo "secret" > file` is how the docs said to seed one. Sealing captures
    // the trimmed value, so the newline does not become part of the secret.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, SCOPE_DIRS[0][1], "acme.key", "s3cret\n");
      await store.reconcile?.();
      expect((await store.get(INSTANCE, "acme.key", READ))?.reveal()).toBe("s3cret");
    } finally {
      cleanup();
    }
  });

  test("a temp file left by a killed put is not swept up as a key", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, SCOPE_DIRS[1][1], ".acme.key.tmp.a1b2c3d4", "half-written");
      await store.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[1][1], ".acme.key.tmp.a1b2c3d4")).toBe("half-written");
    } finally {
      cleanup();
    }
  });

  test("an unsealed store sweeps nothing", async () => {
    const { store, dir, cleanup } = fresh();
    try {
      seed(dir, SCOPE_DIRS[0][1], "acme.key", "s3cret");
      await store.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[0][1], "acme.key")).toBe("s3cret");
    } finally {
      cleanup();
    }
  });
});

describe("idempotence", () => {
  test("a second sweep changes no bytes", async () => {
    // Every boot after the first runs this. If it rewrote, each restart would
    // burn a write per secret and reset the mtime of every one.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, SCOPE_DIRS[1][1], "acme.key", "s3cret");
      await store.reconcile?.();
      const first = readRaw(dir, SCOPE_DIRS[1][1], "acme.key");
      await store.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[1][1], "acme.key")).toBe(first);
    } finally {
      cleanup();
    }
  });

  test("a value written by the store is already current", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.put(WS, "acme.key", "s3cret");
      const before = readRaw(dir, SCOPE_DIRS[1][1], "acme.key");
      await store.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[1][1], "acme.key")).toBe(before);
    } finally {
      cleanup();
    }
  });
});

describe("mtime survives the sweep", () => {
  // `list()` derives `updatedAt` from mtime. Without preservation the first
  // boot after enabling sealing — and every rotation after — reports every
  // secret as just-changed, so "last set" silently becomes "last sealed" and
  // the only provenance `list` offers is destroyed. No other test would catch
  // it: the value still round-trips and the file is still sealed.
  const LONG_AGO = new Date("2024-03-01T12:00:00.000Z");

  test("a re-sealed file keeps its original mtime", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      const path = seed(dir, SCOPE_DIRS[1][1], "acme.key", "s3cret");
      utimesSync(path, LONG_AGO, LONG_AGO);
      await store.reconcile?.();
      expect(statSync(path).mtime.toISOString()).toBe(LONG_AGO.toISOString());
    } finally {
      cleanup();
    }
  });

  test("and `list` still reports when it was set, not when it was sealed", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      utimesSync(seed(dir, SCOPE_DIRS[1][1], "acme.key", "s3cret"), LONG_AGO, LONG_AGO);
      await store.reconcile?.();
      const [entry] = await store.list(WS);
      expect(entry?.updatedAt).toBe(LONG_AGO.toISOString());
    } finally {
      cleanup();
    }
  });

  test("a rotation does not touch it either", async () => {
    const outgoing = createCredentialSealer([KEY_B]);
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A, KEY_B]));
    try {
      const path = seed(
        dir,
        SCOPE_DIRS[1][1],
        "acme.key",
        outgoing.seal("workspace:ws_test", "acme.key", "v"),
      );
      utimesSync(path, LONG_AGO, LONG_AGO);
      await store.reconcile?.();
      expect(statSync(path).mtime.toISOString()).toBe(LONG_AGO.toISOString());
    } finally {
      cleanup();
    }
  });
});

describe("one bad secret does not take the tenant down", () => {
  // The descendant of the eager-open defect: boot must survive a secret it
  // cannot read, because the alternative is a crash loop whose only symptom is
  // a pod that will not start, over a key nothing uses.
  test("an unopenable value is skipped and the healthy ones still convert", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, SCOPE_DIRS[1][1], "good.one", "v1");
      seed(
        dir,
        SCOPE_DIRS[1][1],
        "bad.one",
        createCredentialSealer([KEY_B]).seal("workspace:ws_test", "bad.one", "x"),
      );
      seed(dir, SCOPE_DIRS[1][1], "good.two", "v2");

      await store.reconcile?.();

      expect(readRaw(dir, SCOPE_DIRS[1][1], "good.one").startsWith("NBS1.")).toBe(true);
      expect(readRaw(dir, SCOPE_DIRS[1][1], "good.two").startsWith("NBS1.")).toBe(true);
      expect((await store.get(WS, "good.one", READ))?.reveal()).toBe("v1");
    } finally {
      cleanup();
    }
  });

  test("the skipped file is left exactly as it was", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      const stranded = createCredentialSealer([KEY_B]).seal("workspace:ws_test", "bad.one", "x");
      const path = seed(dir, SCOPE_DIRS[1][1], "bad.one", stranded);
      await store.reconcile?.();
      expect(readFileSync(path, "utf-8")).toBe(stranded);
    } finally {
      cleanup();
    }
  });

  test("a skip is audited rather than swallowed", async () => {
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(
        dir,
        SCOPE_DIRS[1][1],
        "bad.one",
        createCredentialSealer([KEY_B]).seal("workspace:ws_test", "bad.one", "x"),
      );
      await store.reconcile?.();
      expect(events.map((e) => e.data.reason)).toEqual(["reseal_skipped"]);
      expect(events[0]?.data).toMatchObject({ scope: "workspace:ws_test", key: "bad.one" });
    } finally {
      cleanup();
    }
  });

  test("a directory that is not a workspace id is skipped, not walked", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      mkdirSync(join(dir, "workspaces", "not-a-ws-id"), { recursive: true });
      seed(dir, SCOPE_DIRS[0][1], "acme.key", "s3cret");
      await store.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[0][1], "acme.key").startsWith("NBS1.")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("a root the sweep could not read holds strict mode off", () => {
  // "Nothing here" and "could not look" are different answers. A directory that
  // cannot be LISTED can still have its files opened by path, so treating an
  // unlistable root as an empty one lets the sweep report a clean finish over
  // secrets it never saw — and strict mode then refuses the legitimate plaintext
  // underneath it, on a deployment that did nothing wrong.
  test("an unlistable secrets directory is counted, not mistaken for empty", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    const secretsDir = join(dir, ...SCOPE_DIRS[1][1]);
    try {
      seed(dir, SCOPE_DIRS[1][1], "acme.key", "s3cret");
      chmodSync(secretsDir, 0o300); // traversable, not listable
      await store.reconcile?.();
      // The secret was never seen, so plaintext must still be accepted.
      expect((await store.get(WS, "acme.key", READ))?.reveal()).toBe("s3cret");
    } finally {
      chmodSync(secretsDir, 0o700);
      cleanup();
    }
  });

  test("an unlistable owner root is counted too", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    const usersDir = join(dir, "users");
    try {
      seed(dir, SCOPE_DIRS[2][1], "acme.key", "s3cret");
      chmodSync(usersDir, 0o300);
      await store.reconcile?.();
      expect((await store.get(USER, "acme.key", READ))?.reveal()).toBe("s3cret");
    } finally {
      chmodSync(usersDir, 0o700);
      cleanup();
    }
  });

  test("a STRAY FILE under an owner root is benign too — nothing hides under it", async () => {
    // `users/` takes any non-traversal name as an id, so a `.DS_Store` becomes a
    // scope and `readdir` on its secrets path answers ENOTDIR rather than
    // ENOENT. That is still "nothing here": a regular file has nothing under it
    // to open by path, so counting it unreadable would hold strict mode off on
    // every boot, over a file that is not a secret.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(dir, SCOPE_DIRS[2][1], "acme.key", "s3cret");
      writeFileSync(join(dir, "users", ".DS_Store"), "junk");
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[2][1], "injected.key", "attacker-chosen");
      const got = await store.get(USER, "injected.key", READ);
      expect(() => got?.reveal()).toThrow(/plaintext/);
    } finally {
      cleanup();
    }
  });

  test("an ABSENT root is still benign — it arms strict mode as before", async () => {
    // The other half of the distinction: a deployment with no workspaces yet
    // must not be held in permanent non-strict mode by directories that simply
    // do not exist.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "injected.key", "attacker-chosen");
      const got = await store.get(WS, "injected.key", READ);
      expect(() => got?.reveal()).toThrow(/plaintext/);
    } finally {
      cleanup();
    }
  });
});

describe("hand-seeding on a sealed deployment", () => {
  // Strict mode refuses a plaintext file at read, and there is no CLI yet. The
  // path that still works is the one the sweep already provides: write the file,
  // restart, and the sweep converts it before anything reads it. This is what
  // the docs promise, so it gets a test rather than a sentence.
  test("a plaintext file written before a restart is sealed by the sweep and reads", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.reconcile?.(); // first boot: clean, strict armed
      seed(dir, SCOPE_DIRS[0][1], "anthropic.api_key", "sk-seeded-by-hand\n");
      // The same process refuses it...
      const refused = await store.get(INSTANCE, "anthropic.api_key", READ);
      expect(() => refused?.reveal()).toThrow(/plaintext/);

      // ...and the next boot converts it.
      const next = new FileCredentialStore(dir, { sealer: createCredentialSealer([KEY_A]) });
      await next.reconcile?.();
      expect(readRaw(dir, SCOPE_DIRS[0][1], "anthropic.api_key").startsWith("NBS1.")).toBe(true);
      expect((await next.get(INSTANCE, "anthropic.api_key", READ))?.reveal()).toBe(
        "sk-seeded-by-hand",
      );
    } finally {
      cleanup();
    }
  });
});

describe("strict mode — plaintext is refused once everything is sealed", () => {
  // Sealing buys confidentiality. This is what buys integrity: until it is on,
  // anyone who can WRITE the secrets directory — without holding the key — can
  // drop in a plaintext file holding a credential of their choosing and have it
  // used.
  test("a plaintext file planted after a clean sweep is refused, not read", async () => {
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "injected.key", "attacker-chosen");
      const got = await store.get(WS, "injected.key", READ);
      expect(() => got?.reveal()).toThrow(/plaintext/);
    } finally {
      cleanup();
    }
  });

  test("the refusal is lazy, so planting a file cannot fail a presence probe", async () => {
    // Otherwise writing one plaintext file becomes a way to stop the tenant
    // booting — the same shape as opening eagerly in `get`.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "injected.key", "attacker-chosen");
      expect(await store.get(WS, "injected.key", READ)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("the refusal is audited", async () => {
    const { store, dir, events, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "injected.key", "attacker-chosen");
      const got = await store.get(WS, "injected.key", READ);
      expect(() => got?.reveal()).toThrow();
      expect(events.map((e) => e.data.reason)).toEqual(["plaintext_refused"]);
      expect(JSON.stringify(events)).not.toContain("attacker-chosen");
    } finally {
      cleanup();
    }
  });

  test("a sweep that skipped a file leaves plaintext still accepted", async () => {
    // Conservative on purpose: a sweep that could not finish has not proved
    // every secret is sealed, so it has not earned the right to call plaintext
    // an injection.
    const { store, dir, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      seed(
        dir,
        SCOPE_DIRS[1][1],
        "bad.one",
        createCredentialSealer([KEY_B]).seal("workspace:ws_test", "bad.one", "x"),
      );
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "legacy.key", "still-readable");
      expect((await store.get(WS, "legacy.key", READ))?.reveal()).toBe("still-readable");
    } finally {
      cleanup();
    }
  });

  test("an unsealed store never enters strict mode", async () => {
    const { store, dir, cleanup } = fresh();
    try {
      await store.reconcile?.();
      seed(dir, SCOPE_DIRS[1][1], "legacy.key", "plain");
      expect((await store.get(WS, "legacy.key", READ))?.reveal()).toBe("plain");
    } finally {
      cleanup();
    }
  });

  test("sealed values keep reading normally in strict mode", async () => {
    const { store, cleanup } = fresh(createCredentialSealer([KEY_A]));
    try {
      await store.put(WS, "acme.key", "s3cret");
      await store.reconcile?.();
      expect((await store.get(WS, "acme.key", READ))?.reveal()).toBe("s3cret");
    } finally {
      cleanup();
    }
  });
});
