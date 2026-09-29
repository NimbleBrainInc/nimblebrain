import { describe, expect, it } from "bun:test";
import type { ChatRequest } from "../../../src/runtime/types.ts";

describe("ChatRequest workspaceId", () => {
  // A type-level check: `check:test-signatures` gates excess properties, so
  // this stops compiling if ChatRequest drops the field.
  it("ChatRequest type accepts workspaceId field", () => {
    const req = {
      message: "test",
      workspaceId: "ws_test",
    } satisfies ChatRequest;
    expect(req.workspaceId).toBe("ws_test");
  });
});
