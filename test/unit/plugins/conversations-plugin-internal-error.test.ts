/**
 * A failure the conversations contract has no code for reaches the caller with a fixed
 * message: no path, file handle or other detail of the medium crosses the contract
 * (CONTRACT.md §8). The detail goes only to the plugin's log on stderr.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError } from "@modelcontextprotocol/server";
import { callTool } from "../../../packages/conversations/src/server.ts";
import { type ConversationStore, createStore } from "../../../packages/conversations/src/store.ts";

const SCOPE = { workspaceId: "ws_c0c0c0c0c0c0c0c0", ownerId: "usr_internal" };

let dir: string;
let logged: string[];
let stderr: ReturnType<typeof spyOn>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "conversations-internal-"));
  // The data directory's `workspaces` is a file, so storage cannot be made under it.
  writeFileSync(join(dir, "workspaces"), "not a directory");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(() => stderr?.mockRestore());

function captureStderr(): void {
  logged = [];
  stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  });
}

describe("an internal failure", () => {
  test("a private tool answers internal_error with no path; the log has the detail", async () => {
    captureStderr();
    const result = await callTool(
      createStore(dir),
      "create",
      { model: "anthropic:m" },
      { principal: "host", ...SCOPE },
    );
    expect("isError" in result && result.isError).toBe(true);
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(JSON.parse(text).code).toBe("internal_error");
    expect(text).not.toContain(dir);
    expect(text).not.toContain("/");
    expect(logged.join("")).toContain(dir);
  });

  test("a public tool's JSON-RPC error carries no path; the log has the detail", async () => {
    const failing = `ENOTDIR: not a directory, scandir '${join(dir, "workspaces")}'`;
    const store = {
      ...createStore(dir),
      list: async () => {
        throw new Error(failing);
      },
    } as ConversationStore;
    captureStderr();
    let thrown: unknown;
    try {
      await callTool(store, "list", {}, { principal: "person", ...SCOPE });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(dir);
    expect(message).not.toContain("/");
    expect(logged.join("")).toContain(failing);
  });
});
