import { describe, expect, test } from "bun:test";
import { fileUrl } from "./client";

describe("fileUrl", () => {
  test("builds a bare, workspace-free path from the id", () => {
    // File ids are globally unique; the server resolves the workspace from the
    // id, so the URL carries no workspace or conversation coordinate.
    expect(fileUrl("fl_abc")).toBe("/v1/files/fl_abc");
  });

  test("encodes the file id", () => {
    expect(fileUrl("a/b c")).toBe("/v1/files/a%2Fb%20c");
  });
});
