import { describe, expect, test } from "bun:test";
import { fileIdToUri, FILE_URI_SCHEME, uriToFileId } from "../../../src/files/uri.ts";

describe("file URI helpers", () => {
  test("scheme constant is `files`", () => {
    expect(FILE_URI_SCHEME).toBe("files");
  });

  test("fileIdToUri produces files://<id>", () => {
    expect(fileIdToUri("fl_abc123")).toBe("files://fl_abc123");
  });

  test("uriToFileId round-trips", () => {
    const id = "fl_0123456789abcdef01234567";
    expect(uriToFileId(fileIdToUri(id))).toBe(id);
  });

  test("uriToFileId returns null for non-`files` schemes", () => {
    expect(uriToFileId("ui://files/browser")).toBeNull();
    expect(uriToFileId("file:///etc/passwd")).toBeNull();
    expect(uriToFileId("https://example.com")).toBeNull();
    expect(uriToFileId("not-a-uri")).toBeNull();
  });
});
