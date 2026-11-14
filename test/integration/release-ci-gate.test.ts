import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// release.yml's `ci-green` step, run as written against a fake `gh` that answers each
// API path from a fixture. It decides from the test jobs of the tagged commit's ci.yml
// push run, so these cases cover each job state and which runs count.

const root = join(import.meta.dir, "../..");
const REPO = "acme/runtime";
const TAG = "v1.2.3";
const SHA = "abc123";
const TEST_JOBS = [
  "Lint & Typecheck",
  "Unit Tests",
  "Unit Tests (root deps only)",
  "Integration Tests",
];

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Doc = { jobs: Record<string, { steps: Step[] }> };
type Job = { name: string; status: string; conclusion: string | null };
type Run = { id: number; head_branch: string; jobs: Job[] };

const step = (
  Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")) as Doc
).jobs["ci-green"]?.steps[0];

// gh api <path> [--jq <expr>]: prints the fixture for <path>, filtered like gh does
// (raw strings), or fails when the path has none.
const FAKE_GH = `#!/usr/bin/env bash
body="$(jq -ce --arg p "$2" '.[$p]' "$FIXTURES")" || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
if [ "\${3:-}" = "--jq" ]; then jq -r "$4" <<<"$body"; else printf '%s\\n' "$body"; fi
`;

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-green-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const passed = (extra: Job[] = []): Job[] => [
  ...TEST_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" })),
  ...extra,
];

const gate = (runs: Run[]) => {
  const fixtures: Record<string, unknown> = {
    [`repos/${REPO}/commits/refs/tags/${TAG}`]: { sha: SHA },
    [`repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&per_page=100`]: {
      workflow_runs: runs.map(({ id, head_branch }) => ({ id, head_branch })),
    },
  };
  for (const run of runs) {
    fixtures[`repos/${REPO}/actions/runs/${run.id}`] = {
      head_branch: run.head_branch,
      html_url: `https://example.test/runs/${run.id}`,
    };
    fixtures[`repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`] = { jobs: run.jobs };
  }
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fixtures));
  const result = spawnSync("bash", ["-c", step?.run ?? ""], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FIXTURES: join(dir, "fixtures.json"),
      REPO,
      TAG,
      TEST_JOBS: step?.env?.TEST_JOBS ?? "",
    },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout + result.stderr };
};

describe("release ci-green gate", () => {
  test("the step and its job list are where the test reads them", () => {
    expect(step?.run).toContain("TEST_JOBS");
    expect(JSON.parse(step?.env?.TEST_JOBS ?? "[]")).toEqual(TEST_JOBS);
  });

  test("passes when the test jobs passed, though the image build failed", () => {
    const { status, out } = gate([
      {
        id: 1,
        head_branch: "main",
        jobs: passed([{ name: "Build & Push Images", status: "completed", conclusion: "failure" }]),
      },
    ]);
    expect(status).toBe(0);
    expect(out).toContain("CI test jobs passed on abc123");
  });

  test("passes on a hotfix branch run", () => {
    expect(gate([{ id: 2, head_branch: "hotfix/v1.2", jobs: passed() }]).status).toBe(0);
  });

  test.each([
    ["failure", { status: "completed", conclusion: "failure" }, "failure Unit Tests (main"],
    ["skipped", { status: "completed", conclusion: "skipped" }, "skipped Unit Tests (main"],
    ["running", { status: "in_progress", conclusion: null }, "running Unit Tests (main"],
  ])("refuses a %s test job and names it with its run", (_state, job, line) => {
    const jobs = passed().map((j) => (j.name === "Unit Tests" ? { ...j, ...job } : j));
    const { status, out } = gate([{ id: 3, head_branch: "main", jobs }]);
    expect(status).toBe(1);
    expect(out).toContain(line);
    expect(out).toContain("https://example.test/runs/3");
    expect(out).not.toContain("success Lint & Typecheck");
  });

  test("says a running run is still running", () => {
    const jobs = passed().map((j) =>
      j.name === "Integration Tests" ? { ...j, status: "in_progress", conclusion: null } : j,
    );
    expect(gate([{ id: 4, head_branch: "main", jobs }]).out).toContain("are still running");
  });

  test("refuses a missing test job", () => {
    const jobs = passed().filter((j) => j.name !== "Integration Tests");
    const { status, out } = gate([{ id: 5, head_branch: "main", jobs }]);
    expect(status).toBe(1);
    expect(out).toContain("missing Integration Tests");
  });

  test("refuses when no run is on main or a hotfix branch", () => {
    const { status, out } = gate([{ id: 6, head_branch: "feature/x", jobs: passed() }]);
    expect(status).toBe(1);
    expect(out).toContain("No CI run");
  });
});
