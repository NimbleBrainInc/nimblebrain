/**
 * Tests for `scripts/seed-dev-data.ts` — the dev-workdir seeder behind
 * `bun run seed:dev`.
 *
 * The behaviour under test is the *refusal* to overwrite. A seeded thread is a
 * live chat target — you click into it and the runtime appends your turns to
 * the same file — and a seeded skill dir shares a name with real skills in this
 * org's library. Both paths clobbered real content during review before the
 * marker existed, on separate rounds, so the guard is the part that needs
 * locking rather than the fixtures.
 *
 * The script is a top-level program rather than a module, so these drive it the
 * way a developer does: as a subprocess against a temp workdir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/seed-dev-data.ts");
const USER_ID = "usr_default";
const WORKSPACE_ID = `ws_user_${USER_ID}`;

let workDir: string;

/** Run the seeder against `workDir`, which is never worktree-local here. */
function seed(...extraArgs: string[]) {
  return spawnSync("bun", ["run", SCRIPT, "--force", ...extraArgs], {
    env: { ...process.env, NB_WORK_DIR: workDir },
    encoding: "utf8",
  });
}

const conversationPath = (id: string) =>
  join(workDir, "workspaces", WORKSPACE_ID, "conversations", USER_ID, `${id}.jsonl`);
const orgSkillPath = (name: string) => join(workDir, "skills", `seed-${name}`, "SKILL.md");

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-seed-test-"));
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("seed:dev — workdir guard", () => {
  test("refuses a workdir that is not worktree-local unless forced", () => {
    const result = spawnSync("bun", ["run", SCRIPT], {
      env: { ...process.env, NB_WORK_DIR: workDir },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to seed");
    expect(existsSync(conversationPath("conv_seed_release"))).toBe(false);
  });

  test("--force bypasses the guard and writes", () => {
    const result = seed();
    expect(result.status).toBe(0);
    expect(existsSync(conversationPath("conv_seed_release"))).toBe(true);
  });
});

describe("seed:dev — never clobbers what it did not write", () => {
  test("a re-run replaces its own conversation but keeps the count stable", () => {
    expect(seed().status).toBe(0);
    const before = readFileSync(conversationPath("conv_seed_release"), "utf8");
    expect(seed().status).toBe(0);
    expect(readFileSync(conversationPath("conv_seed_release"), "utf8")).toBe(before);
  });

  test("a conversation without the seed marker survives a re-run", () => {
    const path = conversationPath("conv_seed_release");
    mkdirSync(dirname(path), { recursive: true });
    // A real conversation that happens to occupy a seeded id — no `metadata.seededBy`.
    const real = [
      JSON.stringify({ id: "conv_seed_release", ownerId: USER_ID, format: "events" }),
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "user.message", content: [] }),
    ].join("\n");
    writeFileSync(path, `${real}\n`);

    const result = seed();
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(`${real}\n`);
    expect(result.stderr + result.stdout).toContain("skipped");
  });

  test("appended turns in a seeded conversation are not destroyed", () => {
    expect(seed().status).toBe(0);
    const path = conversationPath("conv_seed_release");

    // Simulate the runtime appending a real turn to a seeded thread, which is
    // exactly what happens the moment you chat in one.
    const appended = `${JSON.stringify({ ts: "2026-09-09T00:00:00.000Z", type: "user.message", content: [{ type: "text", text: "a real turn" }] })}\n`;
    writeFileSync(path, readFileSync(path, "utf8") + appended);
    const linesAfterAppend = readFileSync(path, "utf8").trimEnd().split("\n").length;

    expect(seed().status).toBe(0);
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("a real turn");
    expect(contents.trimEnd().split("\n").length).toBe(linesAfterAppend);
  });

  test("a skill without the seed marker survives a re-run", () => {
    const path = orgSkillPath("mpak-guide");
    mkdirSync(dirname(path), { recursive: true });
    const real = "---\nname: mpak-guide\ndescription: real\n---\n\nhard-won content\n";
    writeFileSync(path, real);

    const result = seed();
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(real);
    expect(result.stderr + result.stdout).toContain("skipped");
  });

  test("a skill it wrote itself is replaced without complaint", () => {
    expect(seed().status).toBe(0);
    const path = orgSkillPath("mpak-guide");
    const before = readFileSync(path, "utf8");
    expect(before).toContain("seeded by scripts/seed-dev-data.ts");

    expect(seed().status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("seed:dev — output", () => {
  test("counts what was written, not what was attempted", () => {
    const path = orgSkillPath("mpak-guide");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "---\nname: mpak-guide\ndescription: real\n---\n\nreal\n");

    const result = seed();
    expect(result.stdout).toContain("3 skills");
  });

  test("seeded conversations use the event format so they render", () => {
    expect(seed().status).toBe(0);
    const lines = readFileSync(conversationPath("conv_seed_release"), "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0]) as { format?: string };
    expect(header.format).toBe("events");
    // A legacy-shaped seed reads back blank: the display projection expects a
    // string `content` while a typed legacy message carries an array.
    const types = lines.slice(1).map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("user.message");
    expect(types).toContain("llm.response");
  });
});
