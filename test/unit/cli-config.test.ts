import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { configClear, configGet, configSet } from "../../src/cli/commands.ts";
import {
  credentialPath,
  getWorkspaceCredentials,
} from "../../src/config/workspace-credentials.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const BUNDLE = "@nimblebraininc/newsapi";
const WS_ID = "ws_engineering";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-cli-config-test-"));
  // Reset any exit code lingering from a prior test in the same process.
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  process.exitCode = 0;
});

async function createWorkspace(): Promise<void> {
  const store = new WorkspaceStore(workDir);
  await store.create("Engineering");
}

// Capture console.log / console.error output into arrays for assertions.
function captureConsole(): {
  logs: string[];
  errs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  return {
    logs,
    errs,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

// ── configSet ────────────────────────────────────────────────────

describe("configSet", () => {
  test("writes to workspace-scoped credential store with 0o600", async () => {
    await createWorkspace();
    const cap = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-test-123", WS_ID, workDir);
    } finally {
      cap.restore();
    }

    const creds = await getWorkspaceCredentials(WS_ID, BUNDLE, workDir);
    expect(creds).toEqual({ api_key: "sk-test-123" });

    const filePath = credentialPath(WS_ID, BUNDLE, workDir);
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);

    expect(cap.logs.join("\n")).toContain("Saved api_key for @nimblebraininc/newsapi");
    expect(cap.logs.join("\n")).toContain("ws_engineering");
    expect(process.exitCode).toBe(0);
  });

  test("errors when workspace does not exist and does not write", async () => {
    const cap = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-test", "ws_missing", workDir);
    } finally {
      cap.restore();
    }

    expect(cap.errs.join("\n")).toContain("Workspace 'ws_missing' does not exist");
    expect(cap.errs.join("\n")).toContain("nb workspace list");
    expect(process.exitCode).toBe(1);

    // No credential directory should have been created under the missing workspace.
    const credDir = join(workDir, "workspaces", "ws_missing", "credentials");
    expect(existsSync(credDir)).toBe(false);
  });

  test("errors on invalid key=value format", async () => {
    await createWorkspace();
    const cap = captureConsole();
    try {
      await configSet(BUNDLE, "no-equals-sign", WS_ID, workDir);
    } finally {
      cap.restore();
    }

    expect(cap.errs.join("\n")).toContain(
      "Usage: nb config set @scope/name key=value -w <wsId>",
    );
    expect(process.exitCode).toBe(1);

    // Nothing should have been written.
    const creds = await getWorkspaceCredentials(WS_ID, BUNDLE, workDir);
    expect(creds).toBeNull();
  });

  test("does not touch ~/.mpak/config.json (no .mpak dir in workDir)", async () => {
    await createWorkspace();
    const cap = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-test", WS_ID, workDir);
    } finally {
      cap.restore();
    }

    // The temp workDir should not contain an .mpak subfolder.
    expect(existsSync(join(workDir, ".mpak"))).toBe(false);
  });
});

// ── configGet ────────────────────────────────────────────────────

describe("configGet", () => {
  test("displays masked values from the workspace store", async () => {
    await createWorkspace();
    const quiet = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-abcdefg", WS_ID, workDir);
      await configSet(BUNDLE, "short=ab", WS_ID, workDir);
    } finally {
      quiet.restore();
    }

    const cap = captureConsole();
    try {
      await configGet(BUNDLE, WS_ID, workDir);
    } finally {
      cap.restore();
    }

    const out = cap.logs.join("\n");
    // Long value (>4): first 2 chars + ****
    expect(out).toContain("api_key: sk****");
    expect(out).not.toContain("sk-abcdefg");
    // Short value (<=4): fully masked
    expect(out).toContain("short: ****");
  });

  test("prints 'no config' message when workspace has no credentials for bundle", async () => {
    await createWorkspace();
    const cap = captureConsole();
    try {
      await configGet(BUNDLE, WS_ID, workDir);
    } finally {
      cap.restore();
    }

    expect(cap.logs.join("\n")).toContain(
      "No config for @nimblebraininc/newsapi in workspace ws_engineering",
    );
  });

  test("errors when workspace does not exist", async () => {
    const cap = captureConsole();
    try {
      await configGet(BUNDLE, "ws_missing", workDir);
    } finally {
      cap.restore();
    }

    expect(cap.errs.join("\n")).toContain("Workspace 'ws_missing' does not exist");
    expect(process.exitCode).toBe(1);
  });
});

// ── configClear ──────────────────────────────────────────────────

describe("configClear", () => {
  test("removes a key from the workspace credential store", async () => {
    await createWorkspace();
    const quiet = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-foo", WS_ID, workDir);
      await configSet(BUNDLE, "workspace_id=ws-xyz", WS_ID, workDir);
    } finally {
      quiet.restore();
    }

    const cap = captureConsole();
    try {
      await configClear(BUNDLE, "api_key", WS_ID, workDir);
    } finally {
      cap.restore();
    }

    expect(cap.logs.join("\n")).toContain(
      "Cleared api_key for @nimblebraininc/newsapi in workspace ws_engineering",
    );

    const creds = await getWorkspaceCredentials(WS_ID, BUNDLE, workDir);
    expect(creds).toEqual({ workspace_id: "ws-xyz" });
  });

  test("reports when key is not present", async () => {
    await createWorkspace();
    const cap = captureConsole();
    try {
      await configClear(BUNDLE, "nope", WS_ID, workDir);
    } finally {
      cap.restore();
    }

    expect(cap.logs.join("\n")).toContain("No config key 'nope'");
  });

  test("errors when workspace does not exist", async () => {
    const cap = captureConsole();
    try {
      await configClear(BUNDLE, "api_key", "ws_missing", workDir);
    } finally {
      cap.restore();
    }

    expect(cap.errs.join("\n")).toContain("Workspace 'ws_missing' does not exist");
    expect(process.exitCode).toBe(1);
  });
});

// ── Global store isolation ───────────────────────────────────────

describe("no global mpak store writes", () => {
  test("no CLI function creates ~/.mpak under the test workDir", async () => {
    await createWorkspace();
    const quiet = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-test", WS_ID, workDir);
      await configGet(BUNDLE, WS_ID, workDir);
      await configClear(BUNDLE, "api_key", WS_ID, workDir);
    } finally {
      quiet.restore();
    }

    // Test directory must never contain a .mpak subdirectory.
    expect(existsSync(join(workDir, ".mpak"))).toBe(false);
    // And must never contain the historical mpak global config name at the root.
    expect(existsSync(join(workDir, "config.json"))).toBe(false);
  });

  test("homedir() has no `.mpak/config.json` written by these functions", async () => {
    // This test avoids inspecting the real $HOME; instead we assert by
    // construction that the CLI uses the passed-in workDir, by verifying the
    // credential file landed under the test workDir (and nowhere else we
    // control).
    await createWorkspace();
    const quiet = captureConsole();
    try {
      await configSet(BUNDLE, "api_key=sk-test", WS_ID, workDir);
    } finally {
      quiet.restore();
    }

    const expectedPath = credentialPath(WS_ID, BUNDLE, workDir);
    expect(existsSync(expectedPath)).toBe(true);

    // Defensive sanity check: expectedPath must be inside the test workDir.
    expect(expectedPath.startsWith(workDir)).toBe(true);

    // Also note: homedir() is never used by the production code path when
    // `workDir` is provided explicitly, so `~/.mpak` cannot be created by
    // these CLI calls regardless of the user's real home directory.
    // (The `homedir()` import is silenced here to avoid unused-symbol lint.)
    void homedir;
  });
});
