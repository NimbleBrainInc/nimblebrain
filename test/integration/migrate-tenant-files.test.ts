/**
 * Exercises scripts/migrate-tenant-files.ts against a fake work tree.
 * Classified as integration because it spawns `bun` on the script.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname ?? __dirname, "..", "..", "scripts", "migrate-tenant-files.ts");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedOldFile(
  id: string,
  filename: string,
  body: string,
  conversationId: string | null,
  extra?: Partial<{ deleted: boolean }>,
): Promise<void> {
  const oldFilesDir = join(workDir, "files");
  await mkdir(oldFilesDir, { recursive: true });
  await writeFile(join(oldFilesDir, `${id}_${filename}`), body);
  const entry = {
    id,
    filename,
    mimeType: "application/octet-stream",
    size: Buffer.byteLength(body),
    tags: [],
    source: "chat",
    conversationId,
    createdAt: new Date().toISOString(),
    description: null,
    ...(extra?.deleted ? { deleted: true, deletedAt: new Date().toISOString() } : {}),
  };
  await appendFile(join(oldFilesDir, "registry.jsonl"), `${JSON.stringify(entry)}\n`);
}

async function seedConversation(wsId: string, convId: string): Promise<void> {
  const dir = join(workDir, "workspaces", wsId, "conversations");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${convId}.jsonl`), "");
}

async function runMigrate(): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, workDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`script exited ${exitCode}: ${stderr}`);
  return stderr;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, "utf-8");
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("migrate-tenant-files", () => {
  test("copies file into the workspace of its conversation", async () => {
    await seedConversation("ws_alpha", "conv_a");
    await seedOldFile("fl_old123_abcdef12", "doc.pdf", "PDFDATA", "conv_a");

    await runMigrate();

    const targetFile = join(workDir, "workspaces", "ws_alpha", "files", "fl_old123_abcdef12_doc.pdf");
    expect(existsSync(targetFile)).toBe(true);
    expect(await readFile(targetFile, "utf-8")).toBe("PDFDATA");

    const registry = await readJsonl(
      join(workDir, "workspaces", "ws_alpha", "files", "registry.jsonl"),
    );
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("fl_old123_abcdef12");
    expect(registry[0].source).toBe("chat");
    expect(registry[0].conversationId).toBe("conv_a");

    // Source is untouched.
    expect(existsSync(join(workDir, "files", "fl_old123_abcdef12_doc.pdf"))).toBe(true);
  });

  test("routes multiple files to their respective workspaces", async () => {
    await seedConversation("ws_alpha", "conv_a");
    await seedConversation("ws_beta", "conv_b");
    await seedOldFile("fl_one1111_aaaaaaaa", "a.bin", "AAAA", "conv_a");
    await seedOldFile("fl_two2222_bbbbbbbb", "b.bin", "BBBB", "conv_b");

    await runMigrate();

    expect(
      existsSync(join(workDir, "workspaces", "ws_alpha", "files", "fl_one1111_aaaaaaaa_a.bin")),
    ).toBe(true);
    expect(
      existsSync(join(workDir, "workspaces", "ws_beta", "files", "fl_two2222_bbbbbbbb_b.bin")),
    ).toBe(true);
    // No cross-contamination.
    expect(
      existsSync(join(workDir, "workspaces", "ws_alpha", "files", "fl_two2222_bbbbbbbb_b.bin")),
    ).toBe(false);
  });

  test("skips entries whose conversation cannot be resolved", async () => {
    // No conversation for conv_missing anywhere.
    await seedOldFile("fl_miss1111_12345678", "ghost.bin", "X", "conv_missing");

    const stderr = await runMigrate();

    expect(stderr).toContain("not resolvable");
    // Source untouched, no workspace target created.
    expect(existsSync(join(workDir, "workspaces"))).toBe(false);
  });

  test("skips tombstoned entries — does not resurrect deleted files", async () => {
    await seedConversation("ws_alpha", "conv_a");
    await seedOldFile("fl_dead1111_deadbeef", "deleted.bin", "", "conv_a", { deleted: true });

    await runMigrate();

    expect(
      existsSync(join(workDir, "workspaces", "ws_alpha", "files", "fl_dead1111_deadbeef_deleted.bin")),
    ).toBe(false);
  });

  test("idempotent: a second run does not duplicate registry entries", async () => {
    await seedConversation("ws_alpha", "conv_a");
    await seedOldFile("fl_once1111_11111111", "once.bin", "X", "conv_a");

    await runMigrate();
    await runMigrate();

    const registry = await readJsonl(
      join(workDir, "workspaces", "ws_alpha", "files", "registry.jsonl"),
    );
    expect(registry).toHaveLength(1);
  });

  test("no-op when no old registry exists", async () => {
    await runMigrate();
    expect(existsSync(join(workDir, "workspaces"))).toBe(false);
  });

  test("preserves file ids across migration so legacy links keep resolving", async () => {
    await seedConversation("ws_alpha", "conv_a");
    await seedOldFile("fl_legacyid_cafef00d", "legacy.bin", "LEGACY", "conv_a");

    await runMigrate();

    // The id stays the same; the regex in handleFileServe accepts the legacy
    // shape, so historical conversation references keep resolving.
    const registry = await readJsonl(
      join(workDir, "workspaces", "ws_alpha", "files", "registry.jsonl"),
    );
    expect(registry[0].id).toBe("fl_legacyid_cafef00d");
  });
});
