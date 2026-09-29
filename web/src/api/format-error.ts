import { ApiClientError } from "./client";

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/**
 * Format an error raised while sending a chat message into a user-facing
 * string. Expands `payload_too_large` 413 responses using the structured
 * `{ limit, received }` details so the toast reads "Upload is 3.0 MB —
 * limit is 25.0 MB." instead of the generic server message.
 */
export function formatSendError(err: unknown): string {
  if (err instanceof ApiClientError && err.code === "payload_too_large") {
    return formatPayloadTooLarge(err);
  }
  if (err instanceof ApiClientError && err.code === "file_upload_error") {
    return formatUploadErrors(err);
  }
  if (err instanceof ApiClientError && err.code === "run_in_progress") {
    return "The assistant is still working on your previous message. Wait for it to finish, then try again.";
  }
  // A resume the workspace in the URL does not hold: a conversation opened from
  // another workspace whose own workspace has not loaded yet (retry once the
  // panel has followed it there), or one deleted since this tab restored it.
  if (err instanceof ApiClientError && err.code === "conversation_not_found") {
    return "This conversation isn't in the workspace you're viewing. Open it from its own workspace, or start a new chat.";
  }
  return err instanceof Error ? err.message : "An unexpected error occurred";
}

/** A body-limit 413 carries `{ limit, received }`; anything else says it in its message. */
function formatPayloadTooLarge(err: ApiClientError): string {
  const limit = typeof err.details?.limit === "number" ? err.details.limit : undefined;
  const received = typeof err.details?.received === "number" ? err.details.received : undefined;
  if (limit !== undefined && received !== undefined) {
    return `Upload is ${humanBytes(received)} — limit is ${humanBytes(limit)}.`;
  }
  return err.message;
}

/** A refused attachment set: the server names each file and the limit it broke. */
function formatUploadErrors(err: ApiClientError): string {
  const errors = Array.isArray(err.details?.errors)
    ? err.details.errors.filter((e): e is string => typeof e === "string")
    : [];
  return errors.length > 0 ? errors.join(" ") : err.message;
}
