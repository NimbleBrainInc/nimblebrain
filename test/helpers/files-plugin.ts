/**
 * Helpers for tests against the bound files plugin: store a file through the
 * kernel's own intake, as an upload does.
 */

import { takeInFile } from "../../src/files/intake.ts";
import type { FileRecord } from "../../src/files/types.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";

/** Store `body` as `ownerId`'s file in `wsId` through the intake; answers its record. */
export async function seedPluginFile(
  runtime: Runtime,
  wsId: string,
  ownerId: string,
  file: { filename: string; mimeType?: string; body: string | Uint8Array; conversationId?: string },
): Promise<FileRecord> {
  const host = runtime.getFiles();
  if (!host) throw new Error("no files plugin is bound");
  const bytes = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
  return takeInFile(
    host,
    {
      workspaceId: wsId,
      ownerId,
      ...(file.conversationId ? { conversationId: file.conversationId } : {}),
    },
    {
      filename: file.filename,
      mimeType: file.mimeType ?? "text/plain",
      size: bytes.byteLength,
      open: () => new Blob([bytes]).stream(),
    },
    { source: "manual" },
  );
}
