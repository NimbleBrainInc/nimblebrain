import { afterEach, describe, expect, test } from "bun:test";
import { fileUrl, setActiveWorkspaceId } from "./client";

describe("fileUrl", () => {
  afterEach(() => {
    setActiveWorkspaceId(null);
  });

  test("includes both ws and conversationId when given", () => {
    const url = fileUrl("f1", "ws1", "conv1");
    const query = new URLSearchParams(url.split("?")[1]);
    expect(url).toContain("/v1/files/f1");
    expect(query.get("ws")).toBe("ws1");
    expect(query.get("conversationId")).toBe("conv1");
  });

  test("omits conversationId when not given", () => {
    const url = fileUrl("f1", "ws1");
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("ws")).toBe("ws1");
    expect(query.has("conversationId")).toBe(false);
  });

  test("falls back to the active workspace when workspaceId is omitted", () => {
    setActiveWorkspaceId("active-ws");
    const url = fileUrl("f1", undefined, "conv1");
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("ws")).toBe("active-ws");
    expect(query.get("conversationId")).toBe("conv1");
  });

  test("emits no query string when there is no workspace or conversation", () => {
    expect(fileUrl("f1")).toBe("/v1/files/f1");
  });

  test("encodes the file id", () => {
    expect(fileUrl("a/b c")).toContain("/v1/files/a%2Fb%20c");
  });
});
