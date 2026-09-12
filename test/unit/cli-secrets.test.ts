/**
 * The `secrets` subcommand.
 *
 * The store's four methods are already covered by the conformance suite, so
 * what is worth pinning here is the command's own contract: the value never
 * comes from `argv`, no path prints a secret, and every operator mistake exits
 * 2 rather than doing something surprising.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { classifyPromptKey, readValueFromStream, runSecrets } from "../../src/cli/secrets.ts";
import { createCredentialSealer } from "../../src/tools/credential-seal.ts";
import { type CredentialStore, FileCredentialStore } from "../../src/tools/credential-store.ts";

const READ = { caller: "test", purpose: "unit test" };

function harness(store?: CredentialStore) {
  const dir = mkdtempSync(join(tmpdir(), "nb-cli-secrets-"));
  const out: string[] = [];
  const err: string[] = [];
  const backing = store ?? new FileCredentialStore(dir);
  const io = {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
    readValue: async () => "sk-from-stdin",
  };
  return {
    dir,
    out,
    err,
    store: backing,
    io,
    run: (argv: string[], readValue?: () => Promise<string>) =>
      runSecrets(argv, readValue ? { ...io, readValue } : io, () => backing),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("set", () => {
  test("writes the value read from the injected reader, in every scope", async () => {
    const h = harness();
    try {
      expect(await h.run(["set", "acme.key"])).toBe(0);
      expect(await h.run(["set", "acme.key", "--scope", "workspace", "--workspace", "ws_test"])).toBe(
        0,
      );
      expect(await h.run(["set", "acme.key", "--scope", "user", "--user", "usr_alex01"])).toBe(0);

      expect((await h.store.get({ kind: "instance" }, "acme.key", READ))?.reveal()).toBe(
        "sk-from-stdin",
      );
      expect(
        (await h.store.get({ kind: "workspace", wsId: "ws_test" }, "acme.key", READ))?.reveal(),
      ).toBe("sk-from-stdin");
      expect(
        (await h.store.get({ kind: "user", userId: "usr_alex01" }, "acme.key", READ))?.reveal(),
      ).toBe("sk-from-stdin");
    } finally {
      h.cleanup();
    }
  });

  test("a value in argv is refused, and the message says why", async () => {
    // The one hard rule of this command. A secret on the command line lands in
    // shell history and in `ps` for every user on the box, and the mistake is
    // unrecoverable once made — the value has to be rotated, not deleted.
    const h = harness();
    try {
      expect(await h.run(["set", "acme.key", "sk-live-oops"])).toBe(2);
      expect(h.err.join("\n")).toContain("never passed on the command line");
      expect(await h.store.list({ kind: "instance" })).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("an empty value is refused rather than overwriting a working credential", async () => {
    // Almost always a pipeline that produced nothing. Writing it replaces a key
    // that works with a blank that fails at a vendor, hours later.
    const h = harness();
    try {
      await h.run(["set", "acme.key"]);
      expect(await h.run(["set", "acme.key"], async () => "")).toBe(2);
      expect((await h.store.get({ kind: "instance" }, "acme.key", READ))?.reveal()).toBe(
        "sk-from-stdin",
      );
    } finally {
      h.cleanup();
    }
  });

  test("it confirms the key and never echoes the value", async () => {
    const h = harness();
    try {
      await h.run(["set", "acme.key"], async () => "sk-do-not-print-me");
      expect([...h.out, ...h.err].join("\n")).toContain("acme.key");
      expect([...h.out, ...h.err].join("\n")).not.toContain("sk-do-not-print-me");
    } finally {
      h.cleanup();
    }
  });

  test("set requires a key", async () => {
    const h = harness();
    try {
      expect(await h.run(["set"])).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe("it writes through the installed backend, holding no format knowledge", () => {
  test("a sealing store makes the CLI write ciphertext, with no CLI change", async () => {
    // The reason this is a thin wrapper over the four methods: sealing is the
    // deployment's decision, and the command inherits it.
    const dir = mkdtempSync(join(tmpdir(), "nb-cli-sealed-"));
    const sealed = new FileCredentialStore(dir, {
      sealer: createCredentialSealer([Buffer.alloc(32, 0x11)]),
    });
    const h = harness(sealed);
    try {
      await h.run(["set", "acme.key"], async () => "sk-secret");
      const raw = readFileSync(join(dir, "credentials", "secrets", "acme.key"), "utf-8");
      expect(raw.startsWith("NBS1.")).toBe(true);
      expect(raw).not.toContain("sk-secret");
      expect((await sealed.get({ kind: "instance" }, "acme.key", READ))?.reveal()).toBe("sk-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});

describe("list", () => {
  test("prints keys and write times, and no values", async () => {
    const h = harness();
    try {
      await h.run(["set", "b.key"], async () => "value-b");
      await h.run(["set", "a.key"], async () => "value-a");
      h.out.length = 0;
      expect(await h.run(["list"])).toBe(0);
      expect(h.out.map((l) => l.split("\t")[0])).toEqual(["a.key", "b.key"]);
      expect(h.out.join("\n")).not.toContain("value-a");
      expect(h.out.join("\n")).not.toContain("value-b");
      for (const line of h.out) {
        expect(Number.isNaN(Date.parse(line.split("\t")[1] as string))).toBe(false);
      }
    } finally {
      h.cleanup();
    }
  });

  test("an empty scope says so on stderr, and exits 0", async () => {
    // Nothing set is a legitimate answer, not a failure — and it goes to stderr
    // so `secrets list | wc -l` still counts only keys.
    const h = harness();
    try {
      expect(await h.run(["list"])).toBe(0);
      expect(h.out).toEqual([]);
      expect(h.err.join("\n")).toContain("no secrets set");
    } finally {
      h.cleanup();
    }
  });

  test("list takes no key", async () => {
    const h = harness();
    try {
      expect(await h.run(["list", "acme.key"])).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe("delete", () => {
  test("removes the key and is idempotent", async () => {
    const h = harness();
    try {
      await h.run(["set", "acme.key"]);
      expect(await h.run(["delete", "acme.key"])).toBe(0);
      expect(await h.store.get({ kind: "instance" }, "acme.key", READ)).toBeNull();
      expect(await h.run(["delete", "acme.key"])).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("delete requires a key", async () => {
    const h = harness();
    try {
      expect(await h.run(["delete"])).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe("scope selection", () => {
  test("instance is the default", async () => {
    const h = harness();
    try {
      await h.run(["set", "acme.key"]);
      expect(await h.store.list({ kind: "instance" })).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  const bad: [string, string[]][] = [
    ["an unknown scope", ["list", "--scope", "tenant"]],
    ["workspace with no id", ["list", "--scope", "workspace"]],
    ["user with no id", ["list", "--scope", "user"]],
    // An id against the wrong scope would silently read or write somewhere
    // other than where the operator meant.
    ["an id against the wrong scope", ["list", "--workspace", "ws_test"]],
    ["a user id against instance", ["list", "--user", "usr_alex01"]],
    ["an unknown command", ["frobnicate"]],
    ["no command at all", []],
    ["an unknown flag", ["list", "--recursive"]],
  ];

  for (const [label, argv] of bad) {
    test(`${label} exits 2 with usage`, async () => {
      const h = harness();
      try {
        expect(await h.run(argv)).toBe(2);
        expect(h.err.join("\n")).toContain("Usage:");
      } finally {
        h.cleanup();
      }
    });
  }
});

describe("reading the value from a stream", () => {
  const read = (s: string) => readValueFromStream(Readable.from([Buffer.from(s, "utf-8")]));

  test("trims one trailing newline, because every shell adds one", async () => {
    expect(await read("sk-value\n")).toBe("sk-value");
    expect(await read("sk-value\r\n")).toBe("sk-value");
  });

  test("and only one — a value that really ends in a blank line keeps it", async () => {
    expect(await read("sk-value\n\n")).toBe("sk-value\n");
  });

  test("interior newlines and whitespace survive", async () => {
    // A PEM key, a JSON blob, a token with padding: all legitimate values.
    expect(await read("-----BEGIN-----\nabc\n-----END-----\n")).toBe(
      "-----BEGIN-----\nabc\n-----END-----",
    );
    expect(await read("  padded  ")).toBe("  padded  ");
  });

  test("a stream that produced nothing reads as empty, and `set` then refuses it", async () => {
    expect(await read("")).toBe("");
  });
});

describe("the hidden prompt's keymap", () => {
  // The prompt echoes nothing, so an operator cannot see that a correction did
  // not land. Every one of these is a key a terminal actually sends.
  test.each([
    ["\r", "submit"],
    ["\n", "submit"],
    ["\u0004", "submit"], // Ctrl-D
    ["\u0003", "cancel"], // Ctrl-C
    ["\u007f", "erase"], // DEL, what most terminals send for Backspace
    ["\b", "erase"], // BS, what the rest send
    ["a", "append"],
    [" ", "append"],
    ["\u00e9", "append"],
  ])("%j is %s", (ch, action) => {
    expect(classifyPromptKey(ch)).toBe(action);
  });
});
