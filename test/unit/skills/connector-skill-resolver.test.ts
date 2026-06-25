import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTOR_SKILLS_REPO_DEFAULT,
  CONNECTOR_SKILLS_VERSION_DEFAULT,
} from "../../../src/config/connector-skills.ts";
import { overlayUrl, resolveOverlay } from "../../../src/skills/connector-skill-resolver.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const cacheDirs: string[] = [];
function tmpCache(): string {
  const d = mkdtempSync(join(tmpdir(), "cskill-"));
  cacheDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of cacheDirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

/** A fetch stand-in driven by a `url -> {status, body}` map, with a call counter. */
function fakeFetch(
  routes: Record<string, { status: number; body?: string }>,
  counter?: { n: number },
): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (counter) counter.n++;
    const u = typeof url === "string" ? url : url.toString();
    const r = routes[u];
    if (!r) return new Response("", { status: 404 });
    return new Response(r.body ?? "", { status: r.status });
  }) as unknown as typeof fetch;
}

describe("overlayUrl", () => {
  test("builds the raw.githubusercontent URL for <identity>/SKILL.md", () => {
    expect(overlayUrl("Owner/repo", "v1.2.0", "composio/gmail")).toBe(
      "https://raw.githubusercontent.com/Owner/repo/v1.2.0/composio/gmail/SKILL.md",
    );
  });
});

describe("resolveOverlay", () => {
  const repo = "Owner/repo";
  const version = "v1.0.0";
  const identity = "composio/gmail";
  const url = overlayUrl(repo, version, identity);

  test("200 returns the body and its sha", async () => {
    const body = "# Gmail\n\nUse the right tool.";
    const res = await resolveOverlay(identity, {
      cacheDir: tmpCache(),
      repo,
      version,
      fetchImpl: fakeFetch({ [url]: { status: 200, body } }),
    });
    expect(res).not.toBeNull();
    expect(res?.body).toBe(body);
    expect(res?.sha).toBe(sha(body));
  });

  test("404 returns null (no overlay curated)", async () => {
    const res = await resolveOverlay(identity, {
      cacheDir: tmpCache(),
      repo,
      version,
      fetchImpl: fakeFetch({ [url]: { status: 404 } }),
    });
    expect(res).toBeNull();
  });

  test("non-404 error throws (fail-closed)", async () => {
    await expect(
      resolveOverlay(identity, {
        cacheDir: tmpCache(),
        repo,
        version,
        fetchImpl: fakeFetch({ [url]: { status: 500, body: "boom" } }),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("a 200 result is cached: a second resolve does not re-fetch", async () => {
    const body = "cached body";
    const counter = { n: 0 };
    const cacheDir = tmpCache();
    const opts = {
      cacheDir,
      repo,
      version,
      fetchImpl: fakeFetch({ [url]: { status: 200, body } }, counter),
    };
    const a = await resolveOverlay(identity, opts);
    const b = await resolveOverlay(identity, opts);
    expect(counter.n).toBe(1);
    expect(b?.body).toBe(a?.body);
    expect(b?.sha).toBe(a?.sha);
  });

  test("a 404 miss is cached: a second resolve does not re-fetch", async () => {
    const counter = { n: 0 };
    const cacheDir = tmpCache();
    const opts = {
      cacheDir,
      repo,
      version,
      fetchImpl: fakeFetch({ [url]: { status: 404 } }, counter),
    };
    expect(await resolveOverlay(identity, opts)).toBeNull();
    expect(await resolveOverlay(identity, opts)).toBeNull();
    expect(counter.n).toBe(1);
  });

  test("expectedSha mismatch throws (integrity, fail-closed)", async () => {
    const body = "real body";
    await expect(
      resolveOverlay(identity, {
        cacheDir: tmpCache(),
        repo,
        version,
        fetchImpl: fakeFetch({ [url]: { status: 200, body } }),
        expectedSha: "deadbeef",
      }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  test("expectedSha match passes", async () => {
    const body = "verified body";
    const res = await resolveOverlay(identity, {
      cacheDir: tmpCache(),
      repo,
      version,
      fetchImpl: fakeFetch({ [url]: { status: 200, body } }),
      expectedSha: sha(body),
    });
    expect(res?.body).toBe(body);
  });

  test("a version bump re-resolves rather than serving the stale cache", async () => {
    const cacheDir = tmpCache();
    const v1Body = "old";
    const v2Body = "new";
    const v1Url = overlayUrl(repo, "v1.0.0", identity);
    const v2Url = overlayUrl(repo, "v2.0.0", identity);
    const fetchImpl = fakeFetch({
      [v1Url]: { status: 200, body: v1Body },
      [v2Url]: { status: 200, body: v2Body },
    });
    const a = await resolveOverlay(identity, { cacheDir, repo, version: "v1.0.0", fetchImpl });
    const b = await resolveOverlay(identity, { cacheDir, repo, version: "v2.0.0", fetchImpl });
    expect(a?.body).toBe(v1Body);
    expect(b?.body).toBe(v2Body);
  });

  test("exposes pinned default repo/version constants", () => {
    expect(CONNECTOR_SKILLS_REPO_DEFAULT).toMatch(/\//);
    expect(CONNECTOR_SKILLS_VERSION_DEFAULT).toMatch(/^v\d/);
  });
});
