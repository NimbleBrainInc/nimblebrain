import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A rebuild of the same commit must pull the same external images and the same
// toolchain CI tested, or the image can change while nothing in the repo did.
// This is a small guard for this repo's two Dockerfiles; the shared build action's
// `check` mode is the general version of it.

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const DOCKERFILES = ["Dockerfile", "web/Dockerfile"];

/** External image references: every FROM and COPY --from= that isn't an earlier stage. */
function externalImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const refs: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const from = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      if (!stages.has(from[1])) refs.push(from[1]);
      if (from[2]) stages.add(from[2]);
      continue;
    }
    const copy = line.match(/^\s*COPY\s+(?:--\S+\s+)*--from=(\S+)/i);
    if (copy && !stages.has(copy[1]) && !/^\d+$/.test(copy[1])) refs.push(copy[1]);
  }
  return refs;
}

describe("build inputs are pinned", () => {
  for (const path of DOCKERFILES) {
    test(`${path}: every external image is pinned by digest`, () => {
      const refs = externalImages(read(path));
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    });
  }

  test("the image's bun, the web build's bun and every workflow's bun are CI's", () => {
    const ci = read(".github/workflows/ci.yml").match(/^\s*BUN_VERSION:\s*"([^"]+)"/m)?.[1];
    expect(ci).toBeDefined();
    const versions = {
      Dockerfile: read("Dockerfile").match(/^ARG BUN_VERSION=(\S+)/m)?.[1],
      "web/Dockerfile": read("web/Dockerfile").match(/^FROM oven\/bun:([0-9.]+)-/m)?.[1],
      "docs-ci.yml": read(".github/workflows/docs-ci.yml").match(/bun-version:\s*"([^"]+)"/)?.[1],
      "docs-pages.yml": read(".github/workflows/docs-pages.yml").match(
        /bun-version:\s*"([^"]+)"/,
      )?.[1],
    };
    expect(versions).toEqual({
      Dockerfile: ci,
      "web/Dockerfile": ci,
      "docs-ci.yml": ci,
      "docs-pages.yml": ci,
    });
  });
});
