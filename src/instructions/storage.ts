import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type InstructionsMeta,
  MAX_INSTRUCTIONS_BYTES,
  type ReadOptions,
  type Scope,
  type WriteOptions,
  type WriteResult,
} from "./types.ts";

/**
 * File-backed storage for platform-owned overlay instructions.
 *
 * Layout, rooted at the runtime's `workDir`:
 *   {workDir}/org/instructions.md                       (Phase 3 — slot reserved)
 *   {workDir}/workspaces/{wsId}/instructions.md         (workspace overlay)
 *
 * Each file has a sibling `instructions.meta.json` with `{ updated_at, updated_by }`.
 * Reading a missing file returns `""`. Writing empty text deletes the pair.
 *
 * Per-bundle instructions are NOT stored here — bundles own their storage,
 * publish a `<sourceName>://instructions` resource, and the platform reads
 * that on every prompt assembly.
 */
export class InstructionsStore {
  constructor(private readonly workDir: string) {}

  async read(opts: ReadOptions): Promise<string> {
    const filePath = this.resolvePath(opts);
    try {
      return await readFile(filePath, "utf-8");
    } catch (err) {
      if (isENOENT(err)) return "";
      throw err;
    }
  }

  async readMeta(opts: ReadOptions): Promise<InstructionsMeta | null> {
    const metaPath = this.resolveMetaPath(opts);
    try {
      const raw = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(raw) as InstructionsMeta;
      if (
        typeof parsed.updated_at !== "string" ||
        (parsed.updated_by !== "agent" && parsed.updated_by !== "ui")
      ) {
        return null;
      }
      return parsed;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  async write(opts: WriteOptions): Promise<WriteResult> {
    const filePath = this.resolvePath(opts);
    const metaPath = this.resolveMetaPath(opts);

    if (opts.text === "") {
      await rmIfExists(filePath);
      await rmIfExists(metaPath);
      return { updated_at: new Date().toISOString() };
    }

    const bytes = Buffer.byteLength(opts.text, "utf-8");
    if (bytes > MAX_INSTRUCTIONS_BYTES) {
      throw new Error(
        `Instructions exceed ${MAX_INSTRUCTIONS_BYTES} byte limit (got ${bytes} bytes)`,
      );
    }

    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

    const updatedAt = new Date().toISOString();
    const meta: InstructionsMeta = { updated_at: updatedAt, updated_by: opts.updatedBy };

    await atomicWrite(filePath, opts.text);
    await atomicWrite(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    return { updated_at: updatedAt };
  }

  private resolvePath(opts: ReadOptions): string {
    return join(this.resolveDir(opts), "instructions.md");
  }

  private resolveMetaPath(opts: ReadOptions): string {
    return join(this.resolveDir(opts), "instructions.meta.json");
  }

  private resolveDir(opts: ReadOptions): string {
    validateScopeArgs(opts);
    if (opts.scope === "org") {
      return join(this.workDir, "org");
    }
    return join(this.workDir, "workspaces", opts.wsId!);
  }
}

/**
 * Defense-in-depth path-component validation. Callers should pass
 * already-validated identifiers; this catches the cases where they don't.
 */
function validateScopeArgs(opts: ReadOptions): void {
  const { scope } = opts;
  if (scope === "org") return;

  if (scope === "workspace") {
    const wsId = opts.wsId;
    if (!wsId) {
      throw new Error("Scope 'workspace' requires a workspace id");
    }
    assertSafePathComponent("workspace id", wsId);
    return;
  }

  // Exhaustive check — surface unhandled scopes loudly.
  const _exhaustive: never = scope;
  throw new Error(`Unknown scope: ${_exhaustive as Scope}`);
}

function assertSafePathComponent(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} contains a null byte`);
  }
  if (value.startsWith("/")) {
    throw new Error(`${label} must not start with '/'`);
  }
  if (value.includes("..")) {
    throw new Error(`${label} must not contain '..'`);
  }
}

let tmpCounter = 0;
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${++tmpCounter}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  await rename(tmpPath, filePath);
}

async function rmIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
