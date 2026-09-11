/**
 * A server's `notifications/resources/list_changed`, from the wire to the
 * runtime event sink.
 *
 * The server end is real: an in-process source whose MCP server sends the
 * notification over the linked transport pair, so the handler under test is the
 * one `McpSource` registers on its SDK client — not a stub of it. From there the
 * chain is `McpSource` → `ToolRegistry` → the workspace registry's listener →
 * `resources.list_changed` on the sink, which the API layer turns into a
 * `data.changed` broadcast (see `derive-data-changed-target.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { createWorkspaceRegistry } from "../../../src/runtime/workspace-runtime.ts";
import { defineInProcessApp, type InProcessResource } from "../../../src/tools/in-process-app.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import { SharedSourceRef, ToolRegistry } from "../../../src/tools/registry.ts";

const WS = "ws_0123456789abcdef";

/** An in-process source that serves one resource, so it advertises `listChanged`. */
async function startResourceSource(name: string): Promise<McpSource> {
  const resources = new Map<string, InProcessResource>([["notes://list", "[]"]]);
  const source = defineInProcessApp(
    { name, version: "1.0.0", tools: [], resources },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

/** Notifications cross the in-memory transport pair on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingSink(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (event) => events.push(event) }, events };
}

let sources: McpSource[] = [];
afterEach(async () => {
  for (const source of sources) await source.stop();
  sources = [];
});

async function source(name: string): Promise<McpSource> {
  const started = await startResourceSource(name);
  sources.push(started);
  return started;
}

describe("McpSource — resources/list_changed", () => {
  test("a server-pushed list_changed reaches every subscriber", async () => {
    const notes = await source("notes");
    let heard = 0;
    notes.subscribeResourcesListChanged(() => heard++);

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(1);
  });

  test("an unsubscribed listener hears nothing more", async () => {
    const notes = await source("notes");
    let heard = 0;
    const unsubscribe = notes.subscribeResourcesListChanged(() => heard++);
    unsubscribe();

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(0);
  });

  test("the handler is re-registered on the next Client, so a restart does not go quiet", async () => {
    // Handler tables live on the SDK Client and do not carry across instances.
    const notes = await source("notes");
    let heard = 0;
    notes.subscribeResourcesListChanged(() => heard++);

    await notes.stop();
    await notes.start();
    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(1);
  });

  test("a listener that throws does not stop the others", async () => {
    const notes = await source("notes");
    let heard = 0;
    notes.subscribeResourcesListChanged(() => {
      throw new Error("boom");
    });
    notes.subscribeResourcesListChanged(() => heard++);

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toBe(1);
  });
});

describe("ToolRegistry — resources/list_changed", () => {
  test("reports the source's name to the registry listener", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setResourcesListChangedListener((name) => heard.push(name));
    const notes = await source("notes");
    registry.addSource(notes);

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual(["notes"]);
  });

  test("a listener set after the source was added still hears it", async () => {
    const registry = new ToolRegistry();
    const notes = await source("notes");
    registry.addSource(notes);
    const heard: string[] = [];
    registry.setResourcesListChangedListener((name) => heard.push(name));

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual(["notes"]);
  });

  test("a removed source is detached", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setResourcesListChangedListener((name) => heard.push(name));
    const notes = await source("notes");
    registry.addSource(new SharedSourceRef(notes));
    await registry.removeSource("notes");

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual([]);
  });

  test("a shared source reports through its wrapper", async () => {
    const registry = new ToolRegistry();
    const heard: string[] = [];
    registry.setResourcesListChangedListener((name) => heard.push(name));
    const notes = await source("notes");
    registry.addSource(new SharedSourceRef(notes));

    notes.notifyResourceListChanged();
    await settle();

    expect(heard).toEqual(["notes"]);
  });
});

describe("createWorkspaceRegistry — resources/list_changed", () => {
  test("emits resources.list_changed stamped with the registry's workspace", async () => {
    const { sink, events } = recordingSink();
    const registry = createWorkspaceRegistry(WS, [], null, sink);
    registry.addSource(await source("notes"));
    events.length = 0;

    sources[0]?.notifyResourceListChanged();
    await settle();

    expect(events).toEqual([
      { type: "resources.list_changed", data: { server: "notes", workspaceId: WS } },
    ]);
  });

  test("a platform source shared by two workspaces reports once per workspace", async () => {
    // One source object sits in every workspace registry, and the notification
    // cannot say which workspace it concerns — so each workspace's views hear it.
    const { sink, events } = recordingSink();
    const shared = await source("notes");
    const other = "ws_fedcba9876543210";
    createWorkspaceRegistry(WS, [shared], null, sink);
    createWorkspaceRegistry(other, [shared], null, sink);

    shared.notifyResourceListChanged();
    await settle();

    expect(events.map((e) => e.data.workspaceId).sort()).toEqual([WS, other].sort());
  });
});
