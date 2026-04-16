import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { errorLog } from "../../../src/api/middleware/error-log.ts";
import type { AppEnv } from "../../../src/api/types.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";

/** Minimal Runtime stub that satisfies errorLog's needs. */
function stubRuntime(workDir: string) {
  return {
    getWorkspaceScopedDir(wsId?: string | null) {
      if (wsId) return join(workDir, "workspaces", wsId);
      return workDir;
    },
  } as Parameters<typeof errorLog>[0]["runtime"];
}

/** Collects emitted events for assertion. */
function collectingSink(): { events: EngineEvent[]; sink: EventSink } {
  const events: EngineEvent[] = [];
  return { events, sink: { emit: (e: EngineEvent) => events.push(e) } };
}

function readLogLines(workDir: string, wsId: string): Record<string, unknown>[] {
  const logDir = join(workDir, "workspaces", wsId, "logs");
  if (!existsSync(logDir)) return [];
  const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];
  const content = readFileSync(join(logDir, files[0]), "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((l) => JSON.parse(l));
}

describe("errorLog middleware", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "error-log-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("writes JSONL record for 400 response", async () => {
    const { events, sink } = collectingSink();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("identity", { id: "usr_1", email: "a@b.com", displayName: "A" } as AppEnv["Variables"]["identity"]);
      c.set("workspaceId", "ws_test");
      await next();
    });
    app.use("*", errorLog({ runtime: stubRuntime(workDir), eventSink: sink }));
    app.post("/v1/tools/call", (c) =>
      c.json({ error: "invalid_input", message: "/description: must be string" }, 400),
    );

    const res = await app.request("/v1/tools/call", { method: "POST" });
    expect(res.status).toBe(400);

    const records = readLogLines(workDir, "ws_test");
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe("http.error");
    expect(records[0].status).toBe(400);
    expect(records[0].method).toBe("POST");
    expect(records[0].path).toBe("/v1/tools/call");
    expect(records[0].error).toBe("invalid_input");
    expect(records[0].message).toBe("/description: must be string");
    expect(records[0].userId).toBe("usr_1");
    expect(records[0].workspaceId).toBe("ws_test");
    expect(records[0].ts).toBeDefined();

    // Also emitted to EventSink
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("http.error");
  });

  it("does not write for 200 response", async () => {
    const { events, sink } = collectingSink();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("identity", { id: "usr_1", email: "a@b.com", displayName: "A" } as AppEnv["Variables"]["identity"]);
      c.set("workspaceId", "ws_test");
      await next();
    });
    app.use("*", errorLog({ runtime: stubRuntime(workDir), eventSink: sink }));
    app.get("/v1/ok", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/ok");
    expect(res.status).toBe(200);

    const records = readLogLines(workDir, "ws_test");
    expect(records).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("writes for 401 response with non-JSON body", async () => {
    const { sink } = collectingSink();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("identity", { id: "usr_1", email: "a@b.com", displayName: "A" } as AppEnv["Variables"]["identity"]);
      c.set("workspaceId", "ws_test");
      await next();
    });
    app.use("*", errorLog({ runtime: stubRuntime(workDir), eventSink: sink }));
    app.get("/v1/secret", () => new Response(null, { status: 401 }));

    const res = await app.request("/v1/secret");
    expect(res.status).toBe(401);

    const records = readLogLines(workDir, "ws_test");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe(401);
    expect(records[0].error).toBe("unknown");
  });

  it("writes for 500 response", async () => {
    const { sink } = collectingSink();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("identity", { id: "usr_1", email: "a@b.com", displayName: "A" } as AppEnv["Variables"]["identity"]);
      c.set("workspaceId", "ws_test");
      await next();
    });
    app.use("*", errorLog({ runtime: stubRuntime(workDir), eventSink: sink }));
    app.get("/v1/boom", (c) =>
      c.json({ error: "internal_error", message: "Internal server error" }, 500),
    );

    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);

    const records = readLogLines(workDir, "ws_test");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe(500);
    expect(records[0].error).toBe("internal_error");
  });

  it("writes multiple errors to the same daily log file", async () => {
    const { sink } = collectingSink();
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("identity", { id: "usr_1", email: "a@b.com", displayName: "A" } as AppEnv["Variables"]["identity"]);
      c.set("workspaceId", "ws_test");
      await next();
    });
    app.use("*", errorLog({ runtime: stubRuntime(workDir), eventSink: sink }));
    app.get("/v1/a", (c) => c.json({ error: "not_found", message: "Not found" }, 404));
    app.get("/v1/b", (c) => c.json({ error: "forbidden", message: "Forbidden" }, 403));

    await app.request("/v1/a");
    await app.request("/v1/b");

    const records = readLogLines(workDir, "ws_test");
    expect(records).toHaveLength(2);
    expect(records[0].path).toBe("/v1/a");
    expect(records[1].path).toBe("/v1/b");
  });
});
