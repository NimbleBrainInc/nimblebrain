#!/usr/bin/env bun
/**
 * End-to-end reproducer for issue #116 (bundle subprocess stderr surfacing).
 *
 * Spawns a deliberately-broken Python MCP server as a stdio bundle, runs
 * the production `McpSource` against it, and verifies:
 *
 *   1. The subprocess's stderr lines reach the developer (live `[bundle:…]`
 *      print path).
 *   2. The death is reported via exactly one `source.crashed` event.
 *   3. That event's `stderrTail` payload contains the Python traceback.
 *
 * Run: `bun run scripts/repro-issue-116.ts`
 *
 * Exits non-zero on any contract failure so it can be wired into a smoke
 * check.
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpSource, type McpTransportMode } from "../src/tools/mcp-source.ts";
import type { EngineEvent, EventSink } from "../src/engine/types.ts";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function pass(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string, detail?: string) {
  console.log(`${RED}✗${RESET} ${msg}`);
  if (detail) console.log(`${DIM}    ${detail}${RESET}`);
  failures++;
}

let failures = 0;

const bundleDir = join(tmpdir(), `nb-repro-issue-116-${Date.now()}`);
mkdirSync(bundleDir, { recursive: true });

// Python server that writes some stderr lines, then raises.
// Mirrors the original bug shape — a real ModuleNotFoundError-style death.
const SERVER_PY = `
import sys
print("[broken-bundle] starting up", file=sys.stderr)
print("[broken-bundle] reading config", file=sys.stderr)
print("[broken-bundle] about to import a missing module", file=sys.stderr)
raise ModuleNotFoundError("No module named 'definitely_not_real'")
`;

writeFileSync(join(bundleDir, "server.py"), SERVER_PY);

console.log(`${BOLD}Issue #116 reproducer${RESET}`);
console.log(`${DIM}bundle dir: ${bundleDir}${RESET}`);
console.log("");

// Recording sink so we can assert on emitted events.
const events: EngineEvent[] = [];
const sink: EventSink = {
  emit(e) {
    events.push(e);
  },
};

// Intercept the live drain (log.bundle writes via console.error) so we can
// confirm lines reached the renderer. Restore on cleanup.
const originalConsoleError = console.error;
const consoleLines: string[] = [];
console.error = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  consoleLines.push(line);
  originalConsoleError(...args);
};

const mode: McpTransportMode = {
  type: "stdio",
  spawn: {
    command: "python3",
    args: [join(bundleDir, "server.py")],
    env: process.env as Record<string, string>,
  },
};
const source = new McpSource("broken-bundle", mode, sink);

// Run start() — expected to throw because the subprocess dies during the
// MCP handshake. We catch and inspect the side effects.
let startError: unknown;
try {
  await source.start();
} catch (err) {
  startError = err;
}

// Brief wait so the transport's onclose has a chance to run after the
// thrown error from connect(). The PassThrough on stderr also needs a tick
// for the final 'end' event.
await new Promise((r) => setTimeout(r, 200));

// Restore console before printing results.
console.error = originalConsoleError;

console.log(`${BOLD}Results:${RESET}`);
console.log("");

if (!startError) {
  fail("start() should have thrown — the broken bundle exits during initialize");
} else {
  pass(`start() threw as expected (${(startError as Error).message?.slice(0, 60) ?? "unknown"}…)`);
}

const bundleLines = consoleLines.filter((l) => l.includes("[bundle:broken-bundle]"));
if (bundleLines.length === 0) {
  fail(
    "No [bundle:broken-bundle] lines were rendered to console.error",
    "Expected the live drain to print stderr lines as they were written.",
  );
} else {
  pass(`Live drain rendered ${bundleLines.length} [bundle:…] line(s) to the developer`);
}

const sawStartupBanner = bundleLines.some((l) => l.includes("starting up"));
if (!sawStartupBanner) {
  fail("Live drain did not include the 'starting up' line written before crash");
} else {
  pass("Live drain captured pre-crash stderr (proves attach-at-construction works)");
}

const crashes = events.filter(
  (e) => e.type === "run.error" && (e.data as { event?: string }).event === "source.crashed",
);
if (crashes.length === 0) {
  fail("No source.crashed event was emitted");
} else if (crashes.length > 1) {
  fail(`Expected exactly 1 source.crashed event, got ${crashes.length}`, "Dead-guard de-dup is broken.");
} else {
  pass("Exactly one source.crashed event was emitted (dead-guard works)");
}

if (crashes.length > 0) {
  const data = crashes[0]!.data as { stderrTail?: string };
  const tail = data.stderrTail ?? "";
  if (!tail) {
    fail("source.crashed payload has empty stderrTail", "Ring buffer didn't capture pre-crash output.");
  } else if (!tail.includes("ModuleNotFoundError")) {
    fail(
      "source.crashed.stderrTail is non-empty but doesn't contain 'ModuleNotFoundError'",
      `tail (first 200 chars): ${tail.slice(0, 200)}`,
    );
  } else {
    pass("source.crashed.stderrTail contains the ModuleNotFoundError traceback");
  }
}

// Cleanup
rmSync(bundleDir, { recursive: true, force: true });

console.log("");
if (failures > 0) {
  console.log(`${RED}${BOLD}FAIL${RESET} — ${failures} contract violation(s). Issue #116 fix is broken.`);
  process.exit(1);
}
console.log(`${GREEN}${BOLD}PASS${RESET} — issue #116 fix is wired end-to-end.`);
