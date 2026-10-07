#!/usr/bin/env bun
/**
 * Run the MCP conformance suite against `/mcp/<wsId>`, for each protocol
 * version the endpoint serves, with the suite's reference server installed in
 * the workspace as the connector under test.
 *
 * Each version has a baseline (`expected-failures/<version>.yml`): the
 * scenarios the gateway is known to fail. A run fails when a scenario outside
 * it fails, or when one inside it passes, so the baseline only shrinks.
 *
 * Usage: bun run test:conformance
 * `MCP_CONFORMANCE_SUITE=<version>` runs another suite version (the scheduled
 * job runs the newest, to show what the next pin would change).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startGateway } from "./gateway.ts";

/** The suite version a run checks against, pinned. */
const SUITE_VERSION = process.env.MCP_CONFORMANCE_SUITE || "0.2.0-alpha.12";
/** The suite repo's commit the reference server comes from, matched to the suite version. */
const REFERENCE_COMMIT = "c37eec888e1c6ff140af79987a40008548b7cc5f";
/** The protocol versions `/mcp/<wsId>` serves. */
const SPEC_VERSIONS = ["2026-07-28"] as const;

const ROOT = join(import.meta.dir, "..", "..");
const HERE = import.meta.dir;
const CACHE = join(ROOT, ".cache", "mcp-conformance");
const REFERENCE_FILES = [
  "everything-server.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
];

/**
 * The reference server at the pinned commit, installed from its own lockfile.
 * Fetched rather than copied into this repo: it is the suite's code, under its
 * license, and a pin moves by changing one constant.
 */
async function ensureReference(): Promise<string> {
  const dir = join(CACHE, `reference-${REFERENCE_COMMIT}`);
  if (existsSync(join(dir, "node_modules"))) return dir;
  mkdirSync(dir, { recursive: true });
  for (const file of REFERENCE_FILES) {
    const url = `https://raw.githubusercontent.com/modelcontextprotocol/conformance/${REFERENCE_COMMIT}/examples/servers/typescript/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetching ${url}: HTTP ${res.status}`);
    writeFileSync(join(dir, file), await res.text());
  }
  const install = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("installing the reference server failed");
  return dir;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  probe.stop(true);
  return port;
}

/** Start the reference server and wait until its `/mcp` answers. */
async function startReference(dir: string): Promise<{ url: URL; stop: () => void }> {
  const port = await freePort();
  const child = spawn("bun", ["--no-env-file", "everything-server.ts"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const url = new URL(`http://localhost:${port}/mcp`);
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url, { method: "GET" });
      return { url, stop: () => child.kill() };
    } catch {
      await Bun.sleep(100);
    }
  }
  child.kill();
  throw new Error("the reference server did not start");
}

const reference = await startReference(await ensureReference());
const gateway = await startGateway(reference.url);
const failed: string[] = [];
try {
  for (const version of SPEC_VERSIONS) {
    process.stdout.write(`\n=== MCP conformance ${SUITE_VERSION}, protocol ${version} ===\n`);
    // Async: the gateway runs in this process, so a blocking spawn would starve it.
    const suite = spawn(
      "npx",
      [
        "-y",
        `@modelcontextprotocol/conformance@${SUITE_VERSION}`,
        "server",
        "--url",
        gateway.url,
        // `all`: the suite marks scenarios of a protocol version it has not
        // finalized as pending, and this endpoint serves that version already.
        "--suite",
        "all",
        "--spec-version",
        version,
        "--expected-failures",
        join(HERE, "expected-failures", `${version}.yml`),
        "--output-dir",
        join(CACHE, "results", version),
      ],
      { stdio: "inherit" },
    );
    const code = await new Promise<number | null>((resolve) => suite.on("exit", resolve));
    if (code !== 0) failed.push(version);
  }
} finally {
  await gateway.stop();
  reference.stop();
}
if (failed.length > 0) {
  process.stderr.write(`\nConformance differs from the baseline for: ${failed.join(", ")}\n`);
  process.exit(1);
}
process.exit(0);
