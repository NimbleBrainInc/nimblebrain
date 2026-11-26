/**
 * A small compressed document that inflates to gigabytes must not stall or
 * crash the server. Extraction refuses it from the zip's declared sizes, so
 * the turn still runs with the file attached as metadata and the server keeps
 * answering while the upload is handled.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import type { FilesListOutput } from "../../src/platform/schemas/files.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { postChatTurn } from "../helpers/chat-turn.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import {
  DOCX_MIME,
  docxWithParagraphs,
  XLSX_MIME,
  xlsxWithRows,
} from "../helpers/document-fixtures.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../helpers/test-workspace.ts";

let wsId: string;
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-extraction-bounds-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  const ws = await runtime.getWorkspaceStore().create("Dev's workspace", {
    members: [{ userId: DEV_IDENTITY.id, role: "admin" }],
  });
  wsId = ws.id;
  await runtime.ensureWorkspaceRegistry(wsId);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

/** Time `GET /v1/health` every 20 ms until `done` settles; return the slowest. */
async function slowestHealthWhile(done: Promise<unknown>): Promise<number> {
  let settled = false;
  void done.finally(() => {
    settled = true;
  });
  let slowest = 0;
  while (!settled) {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/v1/health`);
    await res.arrayBuffer();
    slowest = Math.max(slowest, performance.now() - t0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return slowest;
}

async function listedFile(filename: string) {
  const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "files", tool: "list", arguments: { limit: 100 } }),
  });
  const body = (await res.json()) as { content: { text: string }[] };
  const list = JSON.parse(body.content[0]?.text ?? "{}") as FilesListOutput;
  return list.files.find((f) => f.filename === filename);
}

describe("chat upload of a decompression bomb", () => {
  for (const [name, mimeType, build] of [
    ["bomb.xlsx", XLSX_MIME, () => xlsxWithRows(1_000_000)],
    ["bomb.docx", DOCX_MIME, () => docxWithParagraphs(1_000_000)],
  ] as const) {
    it(`${name}: the server stays responsive and the turn runs with the file attached`, async () => {
      const form = new FormData();
      form.append("message", "summarize");
      form.append("files", new File([new Uint8Array(build())], name, { type: mimeType }));

      Bun.gc(true);
      const rss0 = process.memoryUsage().rss;
      const turn = postChatTurn(baseUrl, wsId, { body: form });
      const slowest = await slowestHealthWhile(turn);
      const res = await turn;

      expect(res.status).toBe(200);
      expect(slowest).toBeLessThan(200);
      expect((process.memoryUsage().rss - rss0) / 1048576).toBeLessThan(200);
      const file = await listedFile(name);
      expect(file?.mimeType).toBe(mimeType);
    }, 30_000);
  }
});
