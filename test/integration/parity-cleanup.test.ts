/**
 * How the parity suite (`test/parity/suite.ts`) proves a deployment run's
 * workspaces are gone: only a purge that succeeds, or a successful listing that
 * lacks the workspace, does. And a workspace left behind fails the command line
 * (`test/parity/run.ts`), graded or not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeFetch } from "../helpers/fake-fetch.ts";
import { isClean, runSuite, type Target } from "../parity/suite.ts";

const WS = "ws_parityrun00001";

/**
 * A deployment that creates the run's workspace and refuses to purge it; its
 * listings answer as `listing` says: `ok` without the workspace, `holds` with
 * it, `401` refused.
 */
function deployment(listing: "ok" | "holds" | 401) {
  return async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => ({}))) as { arguments?: { action?: string } };
    const action = body.arguments?.action;
    const reply = (structuredContent: Record<string, unknown>) =>
      Response.json({ content: [{ type: "text", text: "ok" }], structuredContent });
    if (action === "create") return reply({ workspace: { id: WS } });
    if (action === "delete") return reply({ deleted: true });
    if (action === "purge") return new Response("unauthorized", { status: 401 });
    if (listing === 401) return new Response("unauthorized", { status: 401 });
    if (action === "list") return reply({ workspaces: [] });
    if (action === "list_deleted") {
      return reply({ deleted: listing === "holds" ? [{ workspaceId: WS }] : [] });
    }
    return new Response("not found", { status: 404 });
  };
}

function target(): Target {
  return {
    label: "stub",
    kind: "external",
    baseUrl: "http://deployment.invalid",
    alice: { name: "alice", token: "t" },
    capabilities: new Set(["org-admin"]),
    close: async () => {},
  };
}

describe("cleanup after a refused purge", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const stub = (listing: "ok" | "holds" | 401) => {
    const handle = deployment(listing);
    globalThis.fetch = fakeFetch((input, init) => handle(new Request(String(input), init)));
  };

  test("a refused listing leaves the workspace behind", async () => {
    stub(401);
    const report = await runSuite({ target: target(), scenarios: [] });
    expect(report.leftBehind).toHaveLength(1);
    expect(report.leftBehind[0]).toContain(WS);
    expect(report.leftBehind[0]).toContain("list answered 401");
    expect(isClean(report)).toBe(false);
  });

  test("a listing that holds the workspace leaves it behind", async () => {
    stub("holds");
    const report = await runSuite({ target: target(), scenarios: [] });
    expect(report.leftBehind).toEqual([`${WS}: purge refused: unauthorized`]);
  });

  test("successful listings without the workspace show it gone", async () => {
    stub("ok");
    const report = await runSuite({ target: target(), scenarios: [] });
    expect(report.leftBehind).toEqual([]);
  });
});

describe("the command line", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("an ungraded deployment run that leaves a workspace exits non-zero", async () => {
    server = Bun.serve({ port: 0, fetch: deployment(401) });
    dir = mkdtempSync(join(tmpdir(), "parity-cli-"));
    const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../parity/run.ts")], {
      env: {
        PATH: process.env.PATH ?? "",
        PARITY_BASE_URL: `http://localhost:${server.port}`,
        PARITY_TOKEN: "t",
        PARITY_CAPABILITIES: "org-admin",
        PARITY_ONLY: "no-such-scenario",
        PARITY_REPORT: join(dir, "report.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(out).toContain(`LEFT BEHIND ${WS}`);
  });
});
