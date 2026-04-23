import { beforeEach, describe, expect, it } from "bun:test";
import {
  _clearAll,
  register,
  rejectFlow,
  resolveWithCode,
} from "../../src/tools/oauth-flow-registry.ts";

describe("oauth-flow-registry", () => {
  beforeEach(() => {
    _clearAll();
  });

  it("resolves a registered flow with the provided code", async () => {
    const p = register("state-abc", "ws_test", "srv");
    const matched = resolveWithCode("state-abc", "the-code");
    expect(matched).toBe(true);
    await expect(p).resolves.toBe("the-code");
  });

  it("returns false for unknown state on resolve", () => {
    const matched = resolveWithCode("unknown-state", "code");
    expect(matched).toBe(false);
  });

  it("rejects a registered flow with the provided error", async () => {
    const p = register("state-xyz", "ws_test", "srv");
    const rejected = rejectFlow("state-xyz", new Error("boom"));
    expect(rejected).toBe(true);
    await expect(p).rejects.toThrow("boom");
  });

  it("removes the flow after resolve (second resolve is a no-op)", () => {
    register("state-1", "ws_test", "srv");
    expect(resolveWithCode("state-1", "a")).toBe(true);
    expect(resolveWithCode("state-1", "b")).toBe(false);
  });
});
