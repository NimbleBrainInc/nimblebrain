import { describe, expect, it } from "bun:test";
import { createRunGrants, newRunGrantKey } from "../../../src/runtime/run-grant.ts";

const CONTRACT = "ai.nimblebrain.tasks";
const WS = "ws_0123456789abcdef";

describe("run grants", () => {
  const grants = createRunGrants(newRunGrantKey());
  const grant = grants.sign({ contract: CONTRACT, workspaceId: WS, ownerId: "usr_a" });

  it("verifies its own grant and names the owner", () => {
    expect(grant.startsWith("v1.")).toBe(true);
    expect(grants.verify(grant, CONTRACT, WS)).toBe("usr_a");
  });

  it("refuses another contract or workspace", () => {
    expect(grants.verify(grant, "ai.nimblebrain.other", WS)).toBeNull();
    expect(grants.verify(grant, CONTRACT, "ws_fedcba9876543210")).toBeNull();
  });

  it("refuses a grant signed under another key", () => {
    const other = createRunGrants(newRunGrantKey());
    expect(other.verify(grant, CONTRACT, WS)).toBeNull();
  });

  it("refuses claims changed after signing", () => {
    const [version, , signature] = grant.split(".");
    const claims = Buffer.from(JSON.stringify({ c: CONTRACT, w: WS, o: "usr_b" })).toString(
      "base64url",
    );
    expect(grants.verify(`${version}.${claims}.${signature}`, CONTRACT, WS)).toBeNull();
  });

  it("refuses what is not a grant", () => {
    for (const forged of ["", "v1.forged.grant", "v2.a.b", "not-a-grant"]) {
      expect(grants.verify(forged, CONTRACT, WS)).toBeNull();
    }
  });

  it("refuses a key shorter than 32 bytes", () => {
    expect(() => createRunGrants(Buffer.alloc(16).toString("base64url"))).toThrow();
  });
});
