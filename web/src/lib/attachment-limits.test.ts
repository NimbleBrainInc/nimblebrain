import { describe, expect, test } from "bun:test";
import { attachmentLimitHint, attachmentLimitProblem } from "./attachment-limits";

const LIMITS = { maxFileSize: 26_214_400, maxTotalSize: 104_857_600, maxFilesPerMessage: 10 };
const MB = 1_048_576;
const files = (n: number, size = MB) =>
  Array.from({ length: n }, (_, i) => ({ name: `f${i}.pdf`, size }));

describe("attachmentLimitProblem", () => {
  test("allows a set within every limit", () => {
    expect(attachmentLimitProblem(files(10), LIMITS)).toBeNull();
  });

  test("names the per-message count and how many to remove", () => {
    expect(attachmentLimitProblem(files(23), LIMITS)).toBe(
      "Up to 10 files per message. Remove 13 to send.",
    );
  });

  test("names the file over the per-file size", () => {
    const set = [...files(1), { name: "video.mov", size: 30 * MB }];
    expect(attachmentLimitProblem(set, LIMITS)).toBe(
      '"video.mov" is 30.0 MB; each file can be up to 25.0 MB.',
    );
  });

  test("names the total when every file fits but the set does not", () => {
    expect(attachmentLimitProblem(files(5, 24 * MB), LIMITS)).toBe(
      "Attachments total 120.0 MB; a message can carry up to 100.0 MB.",
    );
  });

  test("says nothing without limits or files", () => {
    expect(attachmentLimitProblem(files(50), undefined)).toBeNull();
    expect(attachmentLimitProblem([], LIMITS)).toBeNull();
  });
});

describe("attachmentLimitHint", () => {
  test("states the limits", () => {
    expect(attachmentLimitHint(LIMITS)).toBe("Attach files (up to 10, 25.0 MB each)");
  });

  test("falls back to the plain label", () => {
    expect(attachmentLimitHint(undefined)).toBe("Attach files");
  });
});
