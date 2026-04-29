import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_PRINCIPAL_ID,
  type Connection,
  summarizeConnectionState,
} from "../../src/bundles/connection.ts";

function conn(state: Connection["state"]): Connection {
  return { principalId: "p", state, source: null };
}

describe("summarizeConnectionState", () => {
  test("empty map summarizes to stopped", () => {
    expect(summarizeConnectionState(new Map())).toBe("stopped");
  });

  test("single connection: state passes through", () => {
    for (const state of ["starting", "running", "pending_auth", "crashed", "dead", "stopped"] as const) {
      const m = new Map<string, Connection>();
      m.set("p", conn(state));
      expect(summarizeConnectionState(m)).toBe(state);
    }
  });

  test("any running wins", () => {
    const m = new Map<string, Connection>();
    m.set("a", conn("dead"));
    m.set("b", conn("pending_auth"));
    m.set("c", conn("running"));
    expect(summarizeConnectionState(m)).toBe("running");
  });

  test("pending_auth wins over crashed/dead/stopped/starting when no running", () => {
    const m = new Map<string, Connection>();
    m.set("a", conn("dead"));
    m.set("b", conn("crashed"));
    m.set("c", conn("starting"));
    m.set("d", conn("pending_auth"));
    expect(summarizeConnectionState(m)).toBe("pending_auth");
  });

  test("starting wins over crashed/dead when no running/pending", () => {
    const m = new Map<string, Connection>();
    m.set("a", conn("dead"));
    m.set("b", conn("crashed"));
    m.set("c", conn("starting"));
    expect(summarizeConnectionState(m)).toBe("starting");
  });

  test("crashed wins over dead when no running/pending/starting", () => {
    const m = new Map<string, Connection>();
    m.set("a", conn("dead"));
    m.set("b", conn("crashed"));
    m.set("c", conn("stopped"));
    expect(summarizeConnectionState(m)).toBe("crashed");
  });

  test("WORKSPACE_PRINCIPAL_ID is reserved", () => {
    expect(WORKSPACE_PRINCIPAL_ID).toBe("_workspace");
    expect(WORKSPACE_PRINCIPAL_ID.startsWith("_")).toBe(true);
  });
});
