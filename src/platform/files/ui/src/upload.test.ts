/**
 * The Files app's side of a picker refusal: the host rejects
 * `ai.nimblebrain/request-file` with `error.data = { files, errors }` when it
 * refused any picked file, and the app must name each refused file and why
 * rather than report a plain upload failure (or, worse, a silent success).
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadRefusals } from "./UploadRefusals";
import { readUploadRefusal, uploadLimitHint } from "./upload";

/** The shape the SDK rejects with: an `McpError` carrying the host's `data`. */
function refusalError(data: unknown): Error {
  return Object.assign(new Error("MCP error -32602: 1 of 2 files refused"), { code: -32602, data });
}

describe("readUploadRefusal", () => {
  test("reads the refused files and the stored count off a mixed upload", () => {
    const err = refusalError({
      files: [{ id: "fl_a", filename: "notes.txt" }],
      errors: ['File "setup.exe" has disallowed type: application/x-msdownload'],
    });
    expect(readUploadRefusal(err)).toEqual({
      errors: ['File "setup.exe" has disallowed type: application/x-msdownload'],
      storedIds: ["fl_a"],
    });
  });

  test("an error that names no refused file is not a refusal", () => {
    expect(readUploadRefusal(new Error("Unauthorized"))).toBeNull();
    expect(readUploadRefusal(refusalError({ files: [], errors: [] }))).toBeNull();
    expect(readUploadRefusal(refusalError({ errors: [42] }))).toBeNull();
    expect(readUploadRefusal(null)).toBeNull();
  });
});

describe("UploadRefusals", () => {
  test("shows each refused file and why, and how many were stored", () => {
    const html = renderToStaticMarkup(
      createElement(UploadRefusals, {
        refusal: {
          errors: [
            'File "setup.exe" has disallowed type: application/x-msdownload',
            'File "video.mov" (40.0 MB) exceeds per-file limit of 25.0 MB',
          ],
          storedIds: ["fl_a", "fl_b", "fl_c"],
        },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("2 files weren&#x27;t uploaded");
    expect(html).toContain("(3 uploaded)");
    expect(html).toContain("setup.exe&quot; has disallowed type: application/x-msdownload");
    expect(html).toContain("video.mov&quot; (40.0 MB) exceeds per-file limit of 25.0 MB");
  });

  test("a refusal that stored nothing says only what was refused", () => {
    const html = renderToStaticMarkup(
      createElement(UploadRefusals, {
        refusal: {
          errors: ['File "setup.exe" has disallowed type: application/x-msdownload'],
          storedIds: [],
        },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("1 file wasn&#x27;t uploaded");
    expect(html).not.toContain("uploaded)");
  });
});

describe("uploadLimitHint", () => {
  test("states the per-file and per-upload limits the host publishes", () => {
    expect(uploadLimitHint({ maxFileSize: 26_214_400, maxTotalSize: 104_857_600 })).toBe(
      "Up to 25.0 MB each, 100.0 MB per upload",
    );
  });

  test("states nothing when the host gives no limits", () => {
    expect(uploadLimitHint(undefined)).toBeNull();
  });
});
