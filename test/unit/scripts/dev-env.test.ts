/**
 * Tests for `scripts/lib/dev-env.ts` — the `.env` discovery + parse
 * + merge helpers used by `bun run dev:worktree`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDotenvFile,
  loadDotenvIntoProcess,
  mainRepoRootFor,
  parseDotenv,
} from "../../../scripts/lib/dev-env.ts";

describe("parseDotenv", () => {
  test("parses plain KEY=VALUE lines", () => {
    const m = parseDotenv("FOO=bar\nBAZ=qux\n");
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
    expect(m.size).toBe(2);
  });

  test("skips blanks and comments", () => {
    const m = parseDotenv(
      ["# top-level comment", "", "FOO=bar", "  ", "# inline-ish", "BAZ=qux"].join("\n"),
    );
    expect(m.size).toBe(2);
    expect(m.get("FOO")).toBe("bar");
  });

  test("strips wrapping single and double quotes", () => {
    const m = parseDotenv(['SINGLE=\'hello world\'', 'DOUBLE="hello world"'].join("\n"));
    expect(m.get("SINGLE")).toBe("hello world");
    expect(m.get("DOUBLE")).toBe("hello world");
  });

  test("preserves inline `#` inside quoted values", () => {
    // No inline-comment stripping — see parser doc. Values containing
    // a `#` (e.g. an anchor in a vendor URL) must survive intact.
    const m = parseDotenv('URL="https://example.com/path#section"');
    expect(m.get("URL")).toBe("https://example.com/path#section");
  });

  test("ignores malformed lines without `=`", () => {
    const m = parseDotenv("FOO=bar\nNOT_AN_ENTRY\n=NO_KEY\n");
    expect(m.size).toBe(1);
    expect(m.get("FOO")).toBe("bar");
  });

  test("preserves leading-equals values (`KEY==value` after the first `=`)", () => {
    // The first `=` is the separator; everything after is the value.
    // Operators sometimes paste base64 or signed strings that happen
    // to start with `=`; the parser shouldn't mangle them.
    const m = parseDotenv("KEY==signed-thing==");
    expect(m.get("KEY")).toBe("=signed-thing==");
  });

  test("strips leading `export ` prefix so source-able .env files work", () => {
    // Some operators keep a `.env` that's also `source`-able from a
    // shell, which uses `export NAME=value` syntax. Bun's loader
    // strips the prefix; without it the parser would store the key
    // as `"export FOO"` and the intended var would silently never
    // resolve via `process.env.FOO`.
    const m = parseDotenv(["export FOO=bar", "BAZ=qux", "export  TRIPLE_SPACED=ok"].join("\n"));
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
    expect(m.get("TRIPLE_SPACED")).toBe("ok");
    expect(m.size).toBe(3);
  });

  test("skips keys that still contain whitespace after the export-strip", () => {
    // `FOO BAR=baz` is malformed — no shell can set such a variable,
    // so silently storing it would be a footgun. Skip rather than
    // produce a never-fetchable entry.
    const m = parseDotenv(["FOO BAR=baz", "OK=fine"].join("\n"));
    expect(m.size).toBe(1);
    expect(m.get("OK")).toBe("fine");
  });

  test("strips trailing inline `# comment` from unquoted values (Bun parity)", () => {
    // Matches Bun's `.env` loader. The boundary is `whitespace + #`
    // so values with `#` mid-token (e.g. a hash inside a base64
    // chunk, no surrounding whitespace) aren't truncated.
    const m = parseDotenv(
      [
        "FOO=bar # trailing comment",
        "INLINE_HASH=abc#def", // no whitespace before #, preserved
        "TRAILING_SPACE=baz   ", // pure whitespace, no comment
      ].join("\n"),
    );
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("INLINE_HASH")).toBe("abc#def");
    expect(m.get("TRAILING_SPACE")).toBe("baz");
  });
});

describe("findDotenvFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dev-env-find-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns null when no .env exists in the worktree or main repo", () => {
    // The worktree we create is not in a git checkout, so the
    // main-repo discovery returns null too. findDotenvFile → null.
    expect(findDotenvFile(root)).toBeNull();
  });

  test("returns worktree-local .env when present", () => {
    const path = join(root, ".env");
    writeFileSync(path, "FOO=bar\n");
    expect(findDotenvFile(root)).toBe(path);
  });
});

describe("findDotenvFile / mainRepoRootFor — git worktree discovery", () => {
  // The PR's reason for existing: a linked worktree (e.g.
  // .claude/worktrees/<name>/) needs to find the main repo's `.env`
  // one path level up the shared `.git` dir. Verified empirically
  // before, now pinned with a real `git init` + `git worktree add`
  // so a future refactor of `mainRepoRootFor` can't silently break
  // the only thing this script promises operators.
  let scratch: string;
  let mainRepo: string;
  let worktree: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dev-env-worktree-"));
    mainRepo = join(scratch, "main");
    worktree = join(scratch, "wt");
    mkdirSync(mainRepo, { recursive: true });

    // Real git init in the main repo. Need an initial commit before
    // `git worktree add` will succeed.
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    };
    git(mainRepo, "init", "--initial-branch=main", "-q");
    git(mainRepo, "config", "user.email", "test@example.invalid");
    git(mainRepo, "config", "user.name", "Test");
    git(mainRepo, "config", "commit.gpgsign", "false");
    writeFileSync(join(mainRepo, "README.md"), "# scratch\n");
    git(mainRepo, "add", "README.md");
    git(mainRepo, "commit", "-q", "-m", "init");
    // Linked worktree on a branch off main.
    git(mainRepo, "worktree", "add", "-q", "-b", "feature", worktree);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("mainRepoRootFor returns the main repo root from inside a linked worktree", () => {
    const resolved = mainRepoRootFor(worktree);
    // Resolve through realpath to neutralize /private/var vs /var
    // and other macOS symlink quirks before comparing.
    expect(resolved).not.toBeNull();
    expect(existsSync(join(resolved!, "README.md"))).toBe(true);
  });

  test("findDotenvFile from a linked worktree resolves the main repo's .env", () => {
    const mainEnv = join(mainRepo, ".env");
    writeFileSync(mainEnv, "ANTHROPIC_API_KEY=sk-from-main-repo\n");
    const found = findDotenvFile(worktree);
    expect(found).not.toBeNull();
    // Compare via existsSync rather than path equality — macOS
    // tmpdir symlinks (/var → /private/var) make exact-string
    // comparison fragile.
    expect(found && existsSync(found)).toBe(true);
    expect(found?.endsWith("/.env")).toBe(true);
  });

  test("worktree-local .env wins over main repo .env (discovery order)", () => {
    writeFileSync(join(mainRepo, ".env"), "X=from-main\n");
    writeFileSync(join(worktree, ".env"), "X=from-worktree\n");
    const found = findDotenvFile(worktree);
    expect(found).not.toBeNull();
    // Whatever path was returned, it must come from the worktree,
    // not the main repo.
    expect(found?.startsWith(worktree)).toBe(true);
  });
});

describe("loadDotenvIntoProcess", () => {
  let root: string;
  const TEST_KEY_A = "DEV_ENV_TEST_A_b1f3c";
  const TEST_KEY_B = "DEV_ENV_TEST_B_b1f3c";
  const ORIG_A = process.env[TEST_KEY_A];
  const ORIG_B = process.env[TEST_KEY_B];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dev-env-load-"));
    delete process.env[TEST_KEY_A];
    delete process.env[TEST_KEY_B];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // Restore so a parallel test sharing this process isn't surprised.
    if (ORIG_A === undefined) delete process.env[TEST_KEY_A];
    else process.env[TEST_KEY_A] = ORIG_A;
    if (ORIG_B === undefined) delete process.env[TEST_KEY_B];
    else process.env[TEST_KEY_B] = ORIG_B;
  });

  test("returns null path + empty arrays when no .env is present", () => {
    const result = loadDotenvIntoProcess(root);
    expect(result.path).toBeNull();
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("applies new keys to process.env from a worktree-local .env", () => {
    writeFileSync(join(root, ".env"), `${TEST_KEY_A}=from-file\n${TEST_KEY_B}=also-from-file\n`);
    const result = loadDotenvIntoProcess(root);
    expect(result.path).toBe(join(root, ".env"));
    expect(result.applied.sort()).toEqual([TEST_KEY_A, TEST_KEY_B].sort());
    expect(result.skipped).toEqual([]);
    expect(process.env[TEST_KEY_A]).toBe("from-file");
    expect(process.env[TEST_KEY_B]).toBe("also-from-file");
  });

  test("shell-exported keys win over the .env file (file is skipped)", () => {
    // The load-bearing invariant: a key already in process.env is
    // never overwritten. Operators using direnv / mise / a shell
    // export must be able to override the file value.
    process.env[TEST_KEY_A] = "from-shell";
    writeFileSync(join(root, ".env"), `${TEST_KEY_A}=from-file\n${TEST_KEY_B}=only-in-file\n`);
    const result = loadDotenvIntoProcess(root);
    expect(result.applied).toEqual([TEST_KEY_B]);
    expect(result.skipped).toEqual([TEST_KEY_A]);
    expect(process.env[TEST_KEY_A]).toBe("from-shell");
    expect(process.env[TEST_KEY_B]).toBe("only-in-file");
  });
});
