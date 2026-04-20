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
    const limit = typeof err.details?.limit === "number" ? err.details.limit : undefined;
    const received = typeof err.details?.received === "number" ? err.details.received : undefined;
    if (limit !== undefined && received !== undefined) {
      return `Upload is ${humanBytes(received)} — limit is ${humanBytes(limit)}.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "An unexpected error occurred";
}
