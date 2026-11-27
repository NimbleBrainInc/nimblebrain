/**
 * The kernel's client of the files contract (`contracts/files/CONTRACT.md`):
 * the calls the host makes as `host` on the bound server, and the transfer
 * client its URLs are fetched with. The kernel never names the plugin; it holds
 * whatever implements {@link FILES_CONTRACT}.
 */

import type { BoundServer, HostScope } from "../plugins/bound-servers.ts";
import { createTransferClient, type TransferClient } from "./transfer.ts";
import type { FileRecord } from "./types.ts";

export { FILES_CONTRACT } from "./contract.ts";

/** The most URIs one `resolve` takes. */
export const RESOLVE_MAX_URIS = 100;

/** What `begin_upload` answers. */
export interface OpenUpload {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

/** One entry of `resolve`'s answer. */
export type Resolved =
  | { uri: string; found: true; file: FileRecord; download: { url: string; expiresAt: string } }
  | { uri: string; found: false };

/** What `read` answers, whole (no `pages`). */
export interface ReadAnswer {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extractedText: string | null;
  truncated?: boolean;
}

/** One page of `list`. */
export interface ListPage {
  files: FileRecord[];
  nextCursor: string | null;
  total: number;
}

/** The scope of a call walled to an owner: the workspace, the owner, and the turn or run it is for. */
export type OwnerScope = HostScope & { ownerId: string };

export interface FilesHost {
  /** The version of the contract the kernel consumes, sent on every private call. */
  hostVersion: string;
  transfer: TransferClient;
  beginUpload(
    scope: OwnerScope,
    args: {
      filename: string;
      mimeType: string;
      size: number;
      source: "chat" | "app" | "manual";
      folder?: string;
      tags?: string[];
      description?: string;
    },
  ): Promise<OpenUpload>;
  completeUpload(scope: OwnerScope, uploadId: string): Promise<{ uri: string; file: FileRecord }>;
  /** Every URI's answer, in order, in batches of {@link RESOLVE_MAX_URIS}. */
  resolve(scope: OwnerScope, uris: readonly string[]): Promise<Resolved[]>;
  read(scope: OwnerScope, id: string, maxBytes: number): Promise<ReadAnswer>;
  list(scope: OwnerScope, args: Record<string, unknown>): Promise<ListPage>;
  delete(scope: OwnerScope, id: string): Promise<void>;
}

/**
 * A tool's `structuredContent` as the shape its output schema states. The
 * server checks its private answers against their closed schemas before they
 * leave, and its public ones are the contract's; the kernel reads them as such.
 */
function answer<T>(structured: Record<string, unknown>): T {
  // biome-ignore lint/plugin/double-cast: the bound server's `structuredContent` is untyped JSON; its shape is the contract's output schema for the tool called
  return structured as unknown as T;
}

/** The files client over the server bound to {@link FILES_CONTRACT}. */
export function createFilesHost(server: BoundServer): FilesHost {
  const version = server.hostVersion;
  const transfer = createTransferClient({ destinations: server.transferDestinations });
  return {
    hostVersion: version,
    transfer,
    async beginUpload(scope, args) {
      return answer<OpenUpload>(await server.call("begin_upload", { version, ...args }, scope));
    },
    async completeUpload(scope, uploadId) {
      return answer<{ uri: string; file: FileRecord }>(
        await server.call("complete_upload", { version, uploadId }, scope),
      );
    },
    async resolve(scope, uris) {
      const out: Resolved[] = [];
      for (let i = 0; i < uris.length; i += RESOLVE_MAX_URIS) {
        const batch = uris.slice(i, i + RESOLVE_MAX_URIS);
        const answer = (await server.call("resolve", { version, uris: batch }, scope)) as {
          files?: Resolved[];
        };
        out.push(...(answer.files ?? []));
      }
      return out;
    },
    async read(scope, id, maxBytes) {
      return answer<ReadAnswer>(await server.call("read", { id, maxBytes }, scope));
    },
    async list(scope, args) {
      return answer<ListPage>(await server.call("list", args, scope));
    },
    async delete(scope, id) {
      await server.call("delete", { id }, scope);
    },
  };
}
