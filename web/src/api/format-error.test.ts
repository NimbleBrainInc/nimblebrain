import { describe, expect, test } from "bun:test";
import { ApiClientError } from "./client";
import { formatSendError, humanBytes } from "./format-error";

describe("humanBytes", () => {
  test("handles NaN and negatives by falling back to raw with B suffix", () => {
    expect(humanBytes(Number.NaN)).toBe("NaN B");
    expect(humanBytes(-1)).toBe("-1 B");
  });

  test("bytes below 1 KB render as integer B", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
  });

  test("kilobytes render with 1 decimal and KB suffix", () => {
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(2048)).toBe("2.0 KB");
  });

  test("megabytes render with 1 decimal and MB suffix", () => {
    expect(humanBytes(1_048_576)).toBe("1.0 MB");
    expect(humanBytes(2_097_152)).toBe("2.0 MB");
    expect(humanBytes(25 * 1_048_576)).toBe("25.0 MB");
  });
});

describe("formatSendError", () => {
  test("expands 413 responses with structured limit/received details", () => {
    const err = new ApiClientError("payload_too_large", "Payload too large", 413, {
      limit: 25 * 1_048_576,
      received: 3 * 1_048_576,
      contentType: "multipart/form-data; boundary=abc",
    });
    expect(formatSendError(err)).toBe("Upload is 3.0 MB — limit is 25.0 MB.");
  });

  test("falls back to server message when 413 has no structured details", () => {
    const err = new ApiClientError("payload_too_large", "Payload too large", 413);
    expect(formatSendError(err)).toBe("Payload too large");
  });

  test("falls back to server message when details are wrong-typed", () => {
    const err = new ApiClientError("payload_too_large", "Payload too large", 413, {
      limit: "25 MB",
      received: "3 MB",
    });
    expect(formatSendError(err)).toBe("Payload too large");
  });

  test("a refused attachment set names each file and the limit it broke", () => {
    const err = new ApiClientError("file_upload_error", "File upload failed", 400, {
      errors: ["Too many files: 23 exceeds limit of 10"],
    });
    expect(formatSendError(err)).toBe("Too many files: 23 exceeds limit of 10");
  });

  test("several refusals read as separate reasons", () => {
    const err = new ApiClientError("file_upload_error", "File upload failed", 400, {
      errors: ['File "a.exe" has disallowed type', 'File "b.exe" has disallowed type'],
    });
    expect(formatSendError(err)).toBe(
      'File "a.exe" has disallowed type; File "b.exe" has disallowed type',
    );
  });

  test("a refused attachment set with no reasons keeps the server message", () => {
    const err = new ApiClientError("file_upload_error", "File upload failed", 400, {});
    expect(formatSendError(err)).toBe("File upload failed");
  });

  test("a conversation the URL's workspace does not hold says where to go", () => {
    const err = new ApiClientError("conversation_not_found", "Conversation not found", 404, {
      conversationId: "conv_0123456789abcdef",
    });
    expect(formatSendError(err)).toBe(
      "This conversation isn't in the workspace you're viewing. Open it from its own workspace, or start a new chat.",
    );
  });

  test("non-413 ApiClientError surfaces its message unchanged", () => {
    const err = new ApiClientError("unauthorized", "Please sign in", 401);
    expect(formatSendError(err)).toBe("Please sign in");
  });

  test("plain Error surfaces its message", () => {
    expect(formatSendError(new Error("network down"))).toBe("network down");
  });

  test("non-error rejection produces a generic message", () => {
    expect(formatSendError("something weird")).toBe("An unexpected error occurred");
    expect(formatSendError(undefined)).toBe("An unexpected error occurred");
  });
});
