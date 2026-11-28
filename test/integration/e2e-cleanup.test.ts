/**
 * How the end-to-end suite (`test/e2e/suite.ts`) proves a run put back what it
 * changed: a deployment's workspace is gone only when its purge succeeds, or a
 * successful listing lacks it; a person's timezone is back only when its
 * restore succeeds and reads back. Anything left behind fails the run and the
 * command line (`test/e2e/run.ts`), as does an `--only` that selects nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tasksAuthoring } from "../e2e/scenarios/tasks.ts";
import { isClean, runSuite, type Target } from "../e2e/suite.ts";
import { fakeFetch } from "../helpers/fake-fetch.ts";

const WS = "ws_e2erun00000001";

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
    kind: "deployment",
    baseUrl: "http://deployment.invalid",
    alice: { name: "alice", token: "t" },
    expectCatalog: false,
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

describe("restoring the person's timezone", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  /**
   * A target whose timezone starts as UTC and takes the scenario's write; the
   * restore answers 503 (`refused`) or succeeds without taking (`ignored`).
   * Every other call is refused, so the scenario's own checks fail.
   */
  function stub(restore: "refused" | "ignored"): Target {
    let timezone = "UTC";
    let writes = 0;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/bootstrap") {
          return Response.json({
            user: { id: "usr_a", preferences: { timezone } },
            workspaces: [{ id: WS }],
          });
        }
        const body = (await req.json().catch(() => ({}))) as {
          tool?: string;
          arguments?: { timezone?: string };
        };
        if (body.tool !== "nb__set_preferences") return new Response("no", { status: 404 });
        writes++;
        if (writes > 1 && restore === "refused") return new Response("down", { status: 503 });
        if (writes === 1) timezone = body.arguments?.timezone ?? timezone;
        return Response.json({ content: [{ type: "text", text: "ok" }] });
      },
    });
    return {
      label: "stub",
      kind: "in-process",
      baseUrl: `http://localhost:${server.port}`,
      alice: { name: "alice", token: "t" },
      expectCatalog: false,
      capabilities: new Set(["scripted-model"]),
      close: async () => {},
    };
  }

  test("a refused restore leaves the timezone behind and fails the run", async () => {
    const report = await runSuite({ target: stub("refused"), scenarios: [tasksAuthoring] });
    expect(report.leftBehind).toEqual(["alice's timezone: restore answered 503: down"]);
    expect(isClean(report)).toBe(false);
  });

  test("a restore that does not read back leaves the timezone behind", async () => {
    const report = await runSuite({ target: stub("ignored"), scenarios: [tasksAuthoring] });
    expect(report.leftBehind).toEqual([`alice's timezone: reads "Pacific/Honolulu", wanted "UTC"`]);
  });
});

describe("the command line", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let dir: string | undefined;
  afterEach(() => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a deployment run that leaves a workspace exits non-zero", async () => {
    server = Bun.serve({ port: 0, fetch: deployment(401) });
    dir = mkdtempSync(join(tmpdir(), "e2e-cli-"));
    const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../e2e/run.ts")], {
      env: {
        PATH: process.env.PATH ?? "",
        E2E_BASE_URL: `http://localhost:${server.port}`,
        E2E_TOKEN: "t",
        E2E_CAPABILITIES: "org-admin",
        // Skipped here (no scripted model), so the run only creates and disposes.
        E2E_ONLY: "tasks.authoring",
        E2E_REPORT: join(dir, "report.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(out).toContain(`LEFT BEHIND ${WS}`);
  });

  test("an --only that selects nothing exits non-zero, naming it, before reaching the target", async () => {
    const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../e2e/run.ts")], {
      env: {
        PATH: process.env.PATH ?? "",
        E2E_BASE_URL: "http://deployment.invalid",
        E2E_TOKEN: "t",
        E2E_ONLY: "no-such-scenario",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(err).toContain("--only no-such-scenario matches no scenario");
  });
});
