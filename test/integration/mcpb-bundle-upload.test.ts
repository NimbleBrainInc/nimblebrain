/**
 * Integration coverage for the `.mcpb` upload + install path.
 *
 * Builds a real `.mcpb` archive on disk (zip of `manifest.json`) and drives
 * the production code paths end-to-end:
 *
 * - `POST /v1/bundles/upload` — multipart upload, validation via mpak SDK,
 *   tempfile-then-rename flow, manifest echo back.
 * - Filename uniqueness — two uploads of the same source filename must land
 *   at different on-disk paths.
 * - Path-traversal filename — `../../etc/evil.mcpb` collapses to a basename
 *   inside the workspace bundles dir.
 * - Invalid archive — garbage bytes are rejected and leave nothing behind.
 *
 * **Status until mpak#94 ships.** These tests depend on `validateMcpb`
 * being exported from `@nimblebrain/mpak-sdk`. The pinned version (0.6.0)
 * does not yet export it, so `bun run test:integration` will fail this
 * file until `@nimblebrain/mpak-sdk@>=0.7.0` is published and the
 * dependency is bumped. That is intentional — landing the tests now keeps
 * the contract pinned and turns the SDK bump into a one-line PR that the
 * existing tests gate.
 *
 * Subprocess spawning (the full `manage_app({ action: "install", path })`
 * round-trip) is intentionally NOT exercised here — bundle servers need
 * their own runtime (Python, Node, etc.) and would make this file flaky.
 * The smoke suite is the right home for end-to-end spawn coverage.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-mcpb-upload-${Date.now()}`);
const fixtureDir = join(testDir, "fixtures");

/**
 * Build a minimal valid `.mcpb` archive for a fake bundle named `bundleName`.
 * `.mcpb` is just a zip of `manifest.json` (+ optional server payload).
 * Uses the system `zip` CLI — available on every CI image we run on.
 */
async function buildFixture(bundleName: string, label: string): Promise<string> {
  const stagingDir = join(fixtureDir, `staging-${label}`);
  mkdirSync(stagingDir, { recursive: true });
  // Validator requires the manifest's `entry_point` to exist inside the
  // archive — include a stub script so validation passes. The script is
  // never executed by these tests; we don't drive `manage_app({ install })`.
  const stubScript = "#!/bin/sh\nexit 0\n";
  writeFileSync(join(stagingDir, "server.sh"), stubScript, { mode: 0o755 });
  const manifest = {
    manifest_version: "0.4",
    name: bundleName,
    version: "0.0.1",
    description: `Test fixture: ${bundleName}`,
    author: { name: "test" },
    server: {
      type: "binary",
      entry_point: "server.sh",
      mcp_config: {
        command: "${__dirname}/server.sh",
        args: [],
      },
    },
  };
  writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest));
  const archivePath = join(fixtureDir, `${label}.mcpb`);
  const proc = Bun.spawn(
    [
      "zip",
      "-j",
      archivePath,
      join(stagingDir, "manifest.json"),
      join(stagingDir, "server.sh"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`zip failed (${exitCode}): ${err}`);
  }
  return archivePath;
}

beforeAll(async () => {
  mkdirSync(fixtureDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

const bundlesDir = () => join(testDir, "workspaces", TEST_WORKSPACE_ID, "bundles");

describe("POST /v1/bundles/upload", () => {
  it("accepts a valid .mcpb, validates, and writes into the workspace bundles dir", async () => {
    const archive = await buildFixture("@nb-test/echo", "echo-1");
    const bytes = await Bun.file(archive).arrayBuffer();

    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "application/zip" }),
      "echo.mcpb",
    );

    const res = await fetch(`${baseUrl}/v1/bundles/upload`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.name).toBe("@nb-test/echo");
    expect(body.manifest.version).toBe("0.0.1");
    // Path landed inside the workspace bundles dir.
    expect(body.path.startsWith(bundlesDir())).toBe(true);
    expect(existsSync(body.path)).toBe(true);
  });

  it("uses a randomized filename so two uploads of the same source name don't collide", async () => {
    const archive = await buildFixture("@nb-test/echo2", "echo-2");
    const bytes = await Bun.file(archive).arrayBuffer();

    const upload = async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: "application/zip" }),
        "bundle.mcpb",
      );
      const res = await fetch(`${baseUrl}/v1/bundles/upload`, {
        method: "POST",
        headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
        body: form,
      });
      expect(res.status).toBe(200);
      return (await res.json()).path as string;
    };

    const a = await upload();
    const b = await upload();
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("strips path traversal segments from the upload filename", async () => {
    const archive = await buildFixture("@nb-test/echo3", "echo-3");
    const bytes = await Bun.file(archive).arrayBuffer();

    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "application/zip" }),
      "../../etc/cron.daily/evil.mcpb",
    );

    const res = await fetch(`${baseUrl}/v1/bundles/upload`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Stem is `evil` (basename strips traversal); random suffix appended.
    expect(body.path.startsWith(bundlesDir())).toBe(true);
    expect(body.path).toMatch(/\/evil-[0-9a-f]{16}\.mcpb$/);
  });

  it("rejects a non-.mcpb upload before touching disk", async () => {
    const before = existsSync(bundlesDir()) ? readdirSync(bundlesDir()).length : 0;

    const form = new FormData();
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");

    const res = await fetch(`${baseUrl}/v1/bundles/upload`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });

    expect(res.status).toBe(400);
    const after = existsSync(bundlesDir()) ? readdirSync(bundlesDir()).length : 0;
    expect(after).toBe(before);
  });

  it("rejects an invalid archive and leaves the bundles dir clean", async () => {
    const before = existsSync(bundlesDir()) ? readdirSync(bundlesDir()).length : 0;

    const form = new FormData();
    form.append(
      "file",
      new Blob(["not a real zip"], { type: "application/zip" }),
      "broken.mcpb",
    );

    const res = await fetch(`${baseUrl}/v1/bundles/upload`, {
      method: "POST",
      headers: { "X-Workspace-Id": TEST_WORKSPACE_ID },
      body: form,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_bundle");
    // No artifact landed in the bundles dir — validation runs against a
    // tempfile and the rename only fires on success.
    const after = existsSync(bundlesDir()) ? readdirSync(bundlesDir()).length : 0;
    expect(after).toBe(before);
  });
});
