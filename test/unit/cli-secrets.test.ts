/**
 * The `secrets` subcommand.
 *
 * The store's four methods are already covered by the conformance suite, so
 * what is worth pinning here is the command's own contract: the value never
 * comes from `argv`, no path prints a secret, and every operator mistake exits
 * 2 rather than doing something surprising.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  classifyPromptKey,
  readValueFromStream,
  runSecrets,
  type SecretsCommandIo,
} from "../../src/cli/secrets.ts";
import { defaultWorkDir } from "../../src/connectors/runtime/paths.ts";
import { createCredentialSealer } from "../../src/tools/credential-seal.ts";
import { type CredentialStore, FileCredentialStore } from "../../src/tools/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

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
      runSecrets(argv, readValue ? { ...io, readValue } : io, () => ({
        store: backing,
        configPath: join(dir, "nimblebrain.json"),
        workDir: dir,
        backend: "file",
      })),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("set", () => {
  test("writes the value read from the injected reader, in every scope", async () => {
    const h = harness();
    seedWorkspaceRoot(h.dir, "ws_0076759dbbe19fcc");
    try {
      expect(await h.run(["set", "acme.key"])).toBe(0);
      expect(
        await h.run([
          "set",
          "acme.key",
          "--scope",
          "workspace",
          "--workspace",
          "ws_0076759dbbe19fcc",
        ]),
      ).toBe(0);
      expect(await h.run(["set", "acme.key", "--scope", "user", "--user", "usr_alex01"])).toBe(0);

      expect((await h.store.get({ kind: "instance" }, "acme.key", READ))?.reveal()).toBe(
        "sk-from-stdin",
      );
      expect(
        (
          await h.store.get({ kind: "workspace", wsId: "ws_0076759dbbe19fcc" }, "acme.key", READ)
        )?.reveal(),
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
      expect((await sealed.get({ kind: "instance" }, "acme.key", READ))?.reveal()).toBe(
        "sk-secret",
      );
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
    ["an id against the wrong scope", ["list", "--workspace", "ws_0076759dbbe19fcc"]],
    ["a user id against instance", ["list", "--user", "usr_alex01"]],
    ["an unknown command", ["frobnicate"]],
    ["no command at all", []],
    ["an unknown flag", ["list", "--recursive"]],
  ];

  test("an unknown command is reported before any config is opened", async () => {
    const err: string[] = [];
    const io = {
      stdout: () => {},
      stderr: (line: string) => err.push(line),
      readValue: async () => "",
    };
    const code = await runSecrets(["frobnicate"], io, () => {
      throw new Error("the store was opened");
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain('unknown command "frobnicate"');
  });

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

describe("the work directory both entry points share", () => {
  // The seam the defect sat on: `runServe` passed this and the command did not,
  // so the two read different configs and wrote to different directories, each
  // silently. It is one function now, and this pins the value.
  test("it is NB_WORK_DIR when set, the runtime's default otherwise — never the current directory", () => {
    const previous = process.env.NB_WORK_DIR;
    try {
      process.env.NB_WORK_DIR = "/tmp/nb-explicit";
      expect(defaultWorkDir()).toBe("/tmp/nb-explicit");
      delete process.env.NB_WORK_DIR;
      expect(defaultWorkDir()).toBe(join(homedir(), ".nimblebrain"));
      expect(defaultWorkDir()).not.toBe(process.cwd());
    } finally {
      if (previous === undefined) delete process.env.NB_WORK_DIR;
      else process.env.NB_WORK_DIR = previous;
    }
  });
});

describe("the hidden prompt's keymap", () => {
  // The prompt echoes nothing, so an operator cannot see that a correction did
  // not land. Every one of these is a key a terminal actually sends.
  test.each<[string, ReturnType<typeof classifyPromptKey>]>([
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

describe("a shell holding a different key than the deployment", () => {
  // This store never reconciles, so the boot-time key check never ran on it. An
  // operator whose shell carries the wrong key would seal the value where the
  // server cannot open it.
  test("set against ring [B] over files sealed under A exits non-zero and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-cli-wrong-key-"));
    const underA = createCredentialSealer([Buffer.alloc(32, 0x11)]).seal(
      "instance",
      "existing.key",
      "v",
    );
    mkdirSync(join(dir, "credentials", "secrets"), { recursive: true });
    writeFileSync(join(dir, "credentials", "secrets", "existing.key"), underA);
    const h = harness(
      new FileCredentialStore(dir, { sealer: createCredentialSealer([Buffer.alloc(32, 0x22)]) }),
    );
    let prompted = false;
    try {
      const code = await h.run(["set", "acme.key"], async () => {
        prompted = true;
        return "sk-secret";
      });
      expect(code).toBe(1);
      expect(prompted).toBe(false);
      expect(existsSync(join(dir, "credentials", "secrets", "acme.key"))).toBe(false);
      expect(h.err.join("\n")).toContain("does not hold");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});

describe("where the command decides to write — the real openStore", () => {
  // Every test above injects the store, which is exactly how the one seam that
  // matters went untested. These call `runSecrets` with two arguments, so the
  // command resolves its own config and work directory the way it does for an
  // operator. Both failure modes are silent: the write succeeds, into a place
  // the server never looks.
  //
  // Only the middle one is a regression guard — remove the work-directory
  // default and it is the single test here that goes red. The other two are
  // characterization, for the reasons their own comments give.
  const KEY_ENV = "NB_TEST_CLI_SEAL_KEY";

  /**
   * Runs from a fresh temp directory, because config resolution reads the
   * current one: from a checkout holding a `.nimblebrain/`, these tests would
   * otherwise resolve that instead of the config they set up.
   */
  function scenario(): {
    dir: string;
    io: SecretsCommandIo;
    out: string[];
    err: string[];
    cleanup: () => void;
  } {
    // Real path, so it compares equal to what `process.cwd()` reports on a
    // platform whose temp directory sits behind a symlink.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nb-cli-openstore-")));
    const out: string[] = [];
    const err: string[] = [];
    const previousKey = process.env[KEY_ENV];
    const previousWorkDir = process.env.NB_WORK_DIR;
    const previousCwd = process.cwd();
    process.env[KEY_ENV] = Buffer.alloc(32, 0x11).toString("base64");
    process.chdir(dir);
    return {
      dir,
      out,
      err,
      io: {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        readValue: async () => "sk-from-the-real-path",
      },
      cleanup: () => {
        process.chdir(previousCwd);
        if (previousKey === undefined) delete process.env[KEY_ENV];
        else process.env[KEY_ENV] = previousKey;
        if (previousWorkDir === undefined) delete process.env.NB_WORK_DIR;
        else process.env.NB_WORK_DIR = previousWorkDir;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const SEALED_CONFIG = (workDir: string) =>
    JSON.stringify({
      version: "1",
      workDir,
      secrets: { backend: "file", config: { seal: { keyEnv: KEY_ENV } } },
    });

  test("an explicit --config writes to the work directory that config names", async () => {
    // Characterization. `--config` is priority 1 in `resolveConfigPath` and
    // this config names its own `workDir`, so neither half of the
    // work-directory default is on the path — an explicit `workDir` is exactly
    // the shape under which the original defect was invisible. What it pins is
    // that an explicit config is honored end to end and nothing is written
    // where the operator happened to be standing.
    const s = scenario();
    try {
      const workDir = join(s.dir, "data");
      writeFileSync(join(s.dir, "nimblebrain.json"), SEALED_CONFIG(workDir));
      expect(
        await runSecrets(["set", "acme.key", "--config", join(s.dir, "nimblebrain.json")], s.io),
      ).toBe(0);
      const raw = readFileSync(join(workDir, "credentials", "secrets", "acme.key"), "utf-8");
      expect(raw.startsWith("NBS1.")).toBe(true);
      expect(existsSync(join(process.cwd(), "credentials"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("with no --config it reads the work directory's own config, and seals", async () => {
    // The regression guard, and the command line the docs give. Without the
    // work-directory default, config resolution falls through to the current
    // directory, auto-creates an empty config there, and a deployment that
    // asked to seal writes plaintext — because the config that asked was never
    // opened.
    const s = scenario();
    try {
      process.env.NB_WORK_DIR = s.dir;
      writeFileSync(join(s.dir, "nimblebrain.json"), SEALED_CONFIG(s.dir));
      expect(await runSecrets(["set", "acme.key"], s.io)).toBe(0);
      const raw = readFileSync(join(s.dir, "credentials", "secrets", "acme.key"), "utf-8");
      expect(raw.startsWith("NBS1.")).toBe(true);
      expect(raw).not.toContain("sk-from-the-real-path");
    } finally {
      s.cleanup();
    }
  });

  test("and list reads back from the same place it wrote", async () => {
    // Characterization, for the reason the original defect survived: `set` and
    // `list` resolve identically, so they agree with each other wherever they
    // land — which is why this shape cannot catch a wrong destination. What it
    // pins is that the round trip works at all.
    const s = scenario();
    try {
      process.env.NB_WORK_DIR = s.dir;
      writeFileSync(join(s.dir, "nimblebrain.json"), SEALED_CONFIG(s.dir));
      await runSecrets(["set", "acme.key"], s.io);
      expect(await runSecrets(["list"], s.io)).toBe(0);
      expect(s.out.map((l) => l.split("\t")[0])).toEqual(["acme.key"]);
    } finally {
      s.cleanup();
    }
  });

  test("a config in the current directory and another in the work directory: exits 2, names both, writes nothing", async () => {
    // Resolution would take the current directory's and write there, silently,
    // while the server in the work directory never sees the value.
    const s = scenario();
    try {
      const deployment = join(s.dir, "deployment");
      mkdirSync(deployment);
      writeFileSync(join(deployment, "nimblebrain.json"), SEALED_CONFIG(deployment));
      process.env.NB_WORK_DIR = deployment;
      const local = join(s.dir, ".nimblebrain");
      mkdirSync(local);
      writeFileSync(join(local, "nimblebrain.json"), SEALED_CONFIG(local));

      for (const argv of [["set", "acme.key"], ["delete", "acme.key"], ["list"]]) {
        expect(await runSecrets(argv, s.io)).toBe(2);
      }
      const said = s.err.join("\n");
      expect(said).toContain(join(local, "nimblebrain.json"));
      expect(said).toContain(join(deployment, "nimblebrain.json"));
      expect(said).toContain("--config");
      expect(existsSync(join(deployment, "credentials"))).toBe(false);
      expect(existsSync(join(local, "credentials"))).toBe(false);

      // Naming one resolves it, and the write lands there.
      expect(
        await runSecrets(
          ["set", "acme.key", "--config", join(deployment, "nimblebrain.json")],
          s.io,
        ),
      ).toBe(0);
      expect(existsSync(join(deployment, "credentials", "secrets", "acme.key"))).toBe(true);
      expect(existsSync(join(local, "credentials"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("the same file reached both ways is not ambiguous", async () => {
    const s = scenario();
    try {
      const local = join(s.dir, ".nimblebrain");
      mkdirSync(local);
      writeFileSync(join(local, "nimblebrain.json"), SEALED_CONFIG(local));
      process.env.NB_WORK_DIR = local;
      expect(await runSecrets(["set", "acme.key"], s.io)).toBe(0);
      expect(existsSync(join(local, "credentials", "secrets", "acme.key"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("set and delete say where they are writing first, and never the value", async () => {
    const s = scenario();
    try {
      process.env.NB_WORK_DIR = s.dir;
      writeFileSync(join(s.dir, "nimblebrain.json"), SEALED_CONFIG(s.dir));
      const expected = `config ${join(s.dir, "nimblebrain.json")} · work dir ${s.dir} · backend file · seals yes`;

      expect(await runSecrets(["set", "acme.key"], s.io)).toBe(0);
      expect(s.err[0]).toBe(expected);
      expect(await runSecrets(["delete", "acme.key"], s.io)).toBe(0);
      expect(s.err).toEqual([expected, "set acme.key", expected, "deleted acme.key"]);
      expect(s.err.join("\n")).not.toContain("sk-from-the-real-path");
    } finally {
      s.cleanup();
    }
  });

  test("an unsealed deployment says so", async () => {
    const s = scenario();
    try {
      process.env.NB_WORK_DIR = s.dir;
      writeFileSync(join(s.dir, "nimblebrain.json"), JSON.stringify({ version: "1" }));
      expect(await runSecrets(["set", "acme.key"], s.io)).toBe(0);
      expect(s.err[0]).toEndWith("backend file · seals no");
    } finally {
      s.cleanup();
    }
  });
});
