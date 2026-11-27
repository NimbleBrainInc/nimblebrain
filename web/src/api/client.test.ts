import { describe, expect, test } from "bun:test";
import { fileUrl } from "./client";

describe("fileUrl", () => {
  test("names the workspace the file is served from", () => {
    expect(fileUrl("fl_abc", "ws_0123456789abcdef")).toBe(
      "/v1/workspaces/ws_0123456789abcdef/files/fl_abc",
    );
  });

  test("encodes the file id", () => {
    expect(fileUrl("a/b c", "ws_0123456789abcdef")).toBe(
      "/v1/workspaces/ws_0123456789abcdef/files/a%2Fb%20c",
    );
  });

  test("is null with no workspace given or active", () => {
    expect(fileUrl("fl_abc")).toBeNull();
  });
});
