import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { errorLog } from "../../../src/api/middleware/error-log.ts";
import type { AppEnv } from "../../../src/api/types.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { firstPayloadOf } from "../../helpers/engine-events.ts";

/** Collects emitted events for assertion. */
function collectingSink(): { events: EngineEvent[]; sink: EventSink } {
  const events: EngineEvent[] = [];
  return { events, sink: { emit: (e: EngineEvent) => events.push(e) } };
}

function appWith(sink: EventSink): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("identity", {
      id: "usr_1",
      email: "a@b.com",
      displayName: "A",
    } as AppEnv["Variables"]["identity"]);
    c.set("workspaceId", "ws_0076759dbbe19fcc");
    await next();
  });
  app.use("*", errorLog({ eventSink: sink }));
  return app;
}

describe("errorLog middleware", () => {
  it("emits an http.error record for a 400 response", async () => {
    const { events, sink } = collectingSink();
    const app = appWith(sink);
    app.post("/v1/workspaces/ws_0076759dbbe19fcc/tools/call", (c) =>
      c.json({ error: "invalid_input", message: "/description: must be string" }, 400),
    );

    const res = await app.request("/v1/workspaces/ws_0076759dbbe19fcc/tools/call", {
      method: "POST",
    });
    expect(res.status).toBe(400);

    expect(events).toHaveLength(1);
    const record = firstPayloadOf(events, "http.error")!;
    expect(record.event).toBe("http.error");
    expect(record.status).toBe(400);
    expect(record.method).toBe("POST");
    expect(record.path).toBe("/v1/workspaces/ws_0076759dbbe19fcc/tools/call");
    expect(record.error).toBe("invalid_input");
    expect(record.message).toBe("/description: must be string");
    expect(record.userId).toBe("usr_1");
    expect(record.workspaceId).toBe("ws_0076759dbbe19fcc");
    expect(record.ts).toBeDefined();
  });

  it("emits nothing for a 200 response", async () => {
    const { events, sink } = collectingSink();
    const app = appWith(sink);
    app.get("/v1/ok", (c) => c.json({ ok: true }));

    const res = await app.request("/v1/ok");
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("emits for a 401 response with a non-JSON body", async () => {
    const { events, sink } = collectingSink();
    const app = appWith(sink);
    app.get("/v1/secret", () => new Response(null, { status: 401 }));

    await app.request("/v1/secret");
    expect(events).toHaveLength(1);
    expect(firstPayloadOf(events, "http.error")?.status).toBe(401);
    expect(firstPayloadOf(events, "http.error")?.error).toBe("unknown");
  });

  it("emits for a 500 response", async () => {
    const { events, sink } = collectingSink();
    const app = appWith(sink);
    app.get("/v1/boom", (c) =>
      c.json({ error: "internal_error", message: "Internal server error" }, 500),
    );

    await app.request("/v1/boom");
    expect(events).toHaveLength(1);
    expect(firstPayloadOf(events, "http.error")?.status).toBe(500);
    expect(firstPayloadOf(events, "http.error")?.error).toBe("internal_error");
  });
});
