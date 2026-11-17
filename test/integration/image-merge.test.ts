import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ci.yml's `build-and-push` merge step, run as written against a fake `docker` that
// answers `buildx imagetools` from per-tag files. It joins the per-platform digests
// under `:<sha>`, so these cases cover a fresh merge, a re-run onto an existing tag,
// an absent digest, an inspect error, and an index missing a platform.

const root = join(import.meta.dir, "../..");
const REG = "registry.example.test";
const SHA = "abc1234";
const REVISION = "abc1234def5678";
const IMAGES = ["nimblebrain-runtime", "nimblebrain-web"] as const;

type Step = { name?: string; run?: string };
type Doc = { jobs: Record<string, { steps: Step[] }> };

const step = (
  Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Doc
).jobs["build-and-push"]?.steps.find((s) => s.name === "Tag the multi-platform images");

// A tag's state lives in $STATE/<tag with / and : as _>: `.image` is the `--format`
// output of an existing tag, `.error` an inspect failure, `.raw` the index. With none,
// inspect reports "not found". `create` logs its args and writes `.raw` holding the
// platforms in $CREATE_PLATFORMS.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -eu
[ "$1 $2" = "buildx imagetools" ] || { echo "unexpected: $*" >&2; exit 2; }
key() { printf '%s' "$1" | tr '/:' '__'; }
case "$3" in
  inspect)
    f="$STATE/$(key "$4")"
    if [ "$5" = "--raw" ]; then cat "$f.raw"; exit 0; fi
    if [ -f "$f.error" ]; then cat "$f.error" >&2; exit 1; fi
    if [ -f "$f.image" ]; then cat "$f.image"; exit 0; fi
    echo "ERROR: $4: not found" >&2; exit 1 ;;
  create)
    echo "create $*" >> "$STATE/calls"
    jq -n --arg p "$CREATE_PLATFORMS" '{manifests: ($p | split(",") | map(split("/") | {platform: {os: .[0], architecture: .[1]}}) + [{platform: {os: "unknown", architecture: "unknown"}}])}' > "$STATE/$(key "$5").raw" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

let dir = "";
let state = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "image-merge-"));
  state = join(dir, "state");
  Bun.spawnSync(["mkdir", state]);
  writeFileSync(join(dir, "docker"), FAKE_DOCKER);
  chmodSync(join(dir, "docker"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tagFile = (image: string, ext: string) =>
  join(state, `${REG}/nimblebrain/${image}:${SHA}`.replace(/[/:]/g, "_") + ext);

const imageOf = (revision: string) =>
  JSON.stringify({
    "linux/amd64": { config: { Labels: { "org.opencontainers.image.revision": revision } } },
  });

const digests = {
  RUNTIME_AMD64: "sha256:ra",
  RUNTIME_ARM64: "sha256:rb",
  WEB_AMD64: "sha256:wa",
  WEB_ARM64: "sha256:wb",
};

const merge = (env: Partial<typeof digests> = digests, platforms = "linux/amd64,linux/arm64") => {
  const result = spawnSync("bash", ["-c", step?.run ?? ""], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      STATE: state,
      CREATE_PLATFORMS: platforms,
      REG,
      SHA,
      REVISION,
      RUNTIME_AMD64: "",
      RUNTIME_ARM64: "",
      WEB_AMD64: "",
      WEB_ARM64: "",
      ...env,
    },
    encoding: "utf8",
  });
  const callsPath = join(state, "calls");
  const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n") : [];
  return { status: result.status, out: result.stdout + result.stderr, calls };
};

describe("build-and-push multi-platform merge", () => {
  test("the step is where the test reads it", () => {
    expect(step?.run).toContain("imagetools create");
  });

  test("creates each index from both digests and checks its platforms", () => {
    const { status, out, calls } = merge();
    expect(status).toBe(0);
    expect(calls).toEqual([
      `create buildx imagetools create -t ${REG}/nimblebrain/nimblebrain-runtime:${SHA} ${REG}/nimblebrain/nimblebrain-runtime@sha256:ra ${REG}/nimblebrain/nimblebrain-runtime@sha256:rb`,
      `create buildx imagetools create -t ${REG}/nimblebrain/nimblebrain-web:${SHA} ${REG}/nimblebrain/nimblebrain-web@sha256:wa ${REG}/nimblebrain/nimblebrain-web@sha256:wb`,
    ]);
    expect(out).toContain(
      `tagged ${REG}/nimblebrain/nimblebrain-web:${SHA} (linux/amd64,linux/arm64)`,
    );
  });

  test("skips a tag that already holds this commit's build, with no digests", () => {
    for (const image of IMAGES) writeFileSync(tagFile(image, ".image"), imageOf(REVISION));
    const { status, out, calls } = merge({});
    expect(status).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain(`exists: ${REG}/nimblebrain/nimblebrain-runtime:${SHA}`);
    expect(out).toContain(`exists: ${REG}/nimblebrain/nimblebrain-web:${SHA}`);
  });

  test("refuses a tag that holds another commit's build", () => {
    writeFileSync(tagFile("nimblebrain-runtime", ".image"), imageOf("0000000other"));
    const { status, out, calls } = merge();
    expect(status).toBe(1);
    expect(out).toContain(`is not an image of ${REVISION}`);
    expect(calls).toEqual([]);
  });

  test("refuses to create a missing tag when a platform digest is absent", () => {
    const { status, out, calls } = merge({ ...digests, WEB_ARM64: "" });
    expect(status).toBe(1);
    expect(out).toContain("a platform digest is absent");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("nimblebrain-runtime");
  });

  test("fails on an inspect error other than not found, before creating", () => {
    writeFileSync(tagFile("nimblebrain-runtime", ".error"), "ERROR: unauthorized");
    const { status, out, calls } = merge();
    expect(status).toBe(1);
    expect(out).toContain("could not inspect");
    expect(out).toContain("unauthorized");
    expect(calls).toEqual([]);
  });

  test("fails when the created index lacks a platform", () => {
    const { status, out } = merge(digests, "linux/amd64");
    expect(status).toBe(1);
    expect(out).toContain("holds 'linux/amd64', expected linux/amd64,linux/arm64");
  });
});
