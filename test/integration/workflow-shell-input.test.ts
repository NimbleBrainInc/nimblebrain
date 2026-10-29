import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A `${{ }}` expression inside a `run:` script is pasted into the shell source before
// bash parses it, so a tag or input carrying `$(...)` executes. Workflow values reach
// scripts through `env:` instead, where bash only ever sees them as data.

const root = join(import.meta.dir, "../..");
const files = [
  ...readdirSync(join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`),
  ...readdirSync(join(root, ".github/actions"))
    .map((name) => `.github/actions/${name}/action.yml`)
    .filter((path) => existsSync(join(root, path))),
];

type Step = { name?: string; id?: string; run?: string };
type Doc = { jobs?: Record<string, { steps?: Step[] }>; runs?: { steps?: Step[] } };

const steps = (path: string): Step[] => {
  const doc = Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Doc;
  return [
    ...Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []),
    ...(doc.runs?.steps ?? []),
  ];
};

describe("workflow values reach shell scripts as data", () => {
  test("no run script interpolates an expression", () => {
    const interpolating = files.flatMap((path) =>
      steps(path)
        .filter((step) => step.run?.includes("${{"))
        .map((step) => `${path}: ${step.name ?? step.id}`),
    );
    expect(interpolating).toEqual([]);
  });

  test("a substitution-bearing release tag stays literal and is rejected", () => {
    const resolve = steps(".github/workflows/release.yml").find((step) => step.id === "r");
    expect(resolve?.run).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
    try {
      const marker = join(dir, "executed");
      const result = spawnSync("bash", ["-c", resolve?.run ?? ""], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          VERSION: `v$(touch ${marker})`,
          GITHUB_OUTPUT: join(dir, "out"),
        },
        encoding: "utf8",
      });
      expect(existsSync(marker)).toBe(false);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("is not vX.Y.Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
