/**
 * A header re-read resumes from where the last read stopped, so refreshing the
 * index while a turn appends to a long conversation costs the appended events,
 * not a parse of the whole file on the event loop.
 *
 * Two things are pinned: a resumed scan describes the file exactly as a fresh
 * read does, and it really does skip the bytes it already folded. The second is
 * shown by changing an already-folded line in place (same length, same inode):
 * a resumed scan cannot see that change, a fresh read can.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceConversationsDir } from "../../../../src/conversation/paths.ts";
import { ConversationIndex } from "../../../../src/platform/conversations/index-cache.ts";
import {
  headerOfScan,
  readConversationHeader,
  scanConversationHeader,
} from "../../../../src/platform/conversations/jsonl-reader.ts";

const WS = "ws_00000000000000b1";
const OWNER = "usr_alice";
const CONV = "conv_00000000000000b1";

let workDir: string;
let file: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-header-scan-"));
  const dir = workspaceConversationsDir(workDir, WS, OWNER);
  mkdirSync(dir, { recursive: true });
  file = join(dir, `${CONV}.jsonl`);
  const meta = {
    id: CONV,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    title: null,
    model: "model-0",
    ownerId: OWNER,
    workspaceId: WS,
    format: "events",
  };
  writeFileSync(file, `${JSON.stringify(meta)}\n`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

/** One complete turn: a user message and a run with one model response. */
function turn(n: number, inputTokens: number): string {
  const ts = `2026-06-0${n}T00:00:00.000Z`;
  const runId = `run_${n}`;
  return [
    line({ ts, type: "user.message", content: [{ type: "text", text: `question ${n}` }] }),
    line({ ts, type: "run.start", runId }),
    line({
      ts,
      type: "llm.response",
      runId,
      model: `model-${n}`,
      content: [{ type: "text", text: `answer ${n}` }],
      usage: { inputTokens, outputTokens: 10 },
    }),
    line({ ts, type: "run.done", runId }),
  ].join("");
}

async function freshHeader() {
  const header = await readConversationHeader(file);
  expect(header).not.toBeNull();
  return header!;
}

describe("scanConversationHeader resume", () => {
  test("a scan resumed across appends describes the file as a fresh read does", async () => {
    let scan = await scanConversationHeader(file);
    expect(scan).not.toBeNull();

    appendFileSync(file, turn(1, 100));
    scan = await scanConversationHeader(file, scan!);
    appendFileSync(
      file,
      line({ ts: "2026-06-02T00:00:00.000Z", type: "metadata.title", title: "Named" }),
    );
    scan = await scanConversationHeader(file, scan!);
    appendFileSync(file, turn(3, 250));
    scan = await scanConversationHeader(file, scan!);

    expect(headerOfScan(scan!)).toEqual(await freshHeader());
    expect(headerOfScan(scan!)).toMatchObject({
      preview: "question 1",
      messageCount: 4,
      meta: { title: "Named", totalInputTokens: 350, lastModel: "model-3" },
    });
  });

  test("a resumed scan reads only what was appended", async () => {
    appendFileSync(file, turn(1, 100));
    const first = await scanConversationHeader(file);

    // Change the folded model response in place: same length, same inode, line 1 intact.
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"inputTokens":100', '"inputTokens":900'),
    );
    appendFileSync(file, turn(2, 5));

    const resumed = headerOfScan((await scanConversationHeader(file, first!))!);
    expect(resumed.meta.totalInputTokens).toBe(105);
    expect((await freshHeader()).meta.totalInputTokens).toBe(905);
  });

  test("a file replaced at the same path is read from the start", async () => {
    appendFileSync(file, turn(1, 100));
    const first = await scanConversationHeader(file);

    const replacement = `${file}.tmp`;
    writeFileSync(
      replacement,
      readFileSync(file, "utf8").replace('"inputTokens":100', '"inputTokens":900'),
    );
    renameSync(replacement, file);

    const scan = await scanConversationHeader(file, first!);
    expect(headerOfScan(scan!).meta.totalInputTokens).toBe(900);
  });

  test("a file shorter than the last read is read from the start", async () => {
    const lineOne = readFileSync(file, "utf8");
    appendFileSync(file, turn(1, 100));
    const first = await scanConversationHeader(file);

    truncateSync(file, Buffer.byteLength(lineOne));
    const scan = await scanConversationHeader(file, first!);
    expect(headerOfScan(scan!)).toEqual(await freshHeader());
    expect(headerOfScan(scan!).messageCount).toBe(0);
  });

  test("a rewritten line 1 is read from the start", async () => {
    appendFileSync(file, turn(1, 100));
    const first = await scanConversationHeader(file);

    // Same byte length, so only the line-1 comparison can catch it.
    writeFileSync(file, readFileSync(file, "utf8").replace("usr_alice", "usr_alicf"));
    const scan = await scanConversationHeader(file, first!);
    expect(scan!.meta.ownerId).toBe("usr_alicf");
  });

  test("an incomplete final line is left for the next read, not skipped", async () => {
    const event = line({
      ts: "2026-06-01T00:00:00.000Z",
      type: "user.message",
      content: [{ type: "text", text: "late" }],
    });
    appendFileSync(file, event.slice(0, 20));
    const partial = await scanConversationHeader(file);
    expect(headerOfScan(partial!).messageCount).toBe(0);

    appendFileSync(file, event.slice(20));
    const scan = await scanConversationHeader(file, partial!);
    expect(headerOfScan(scan!)).toMatchObject({ messageCount: 1, preview: "late" });
  });
});

describe("ConversationIndex resumes on a named change", () => {
  test("a refresh after an append folds the appended events only", async () => {
    appendFileSync(file, turn(1, 100));
    const index = new ConversationIndex();
    await index.build(join(workDir, "workspaces"));

    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"inputTokens":100', '"inputTokens":900'),
    );
    appendFileSync(file, turn(2, 5));
    index.invalidate({ id: CONV, filePath: file, wsId: WS });
    await index.refresh();

    expect(index.get(CONV)).toMatchObject({ messageCount: 4, totalInputTokens: 105 });
  });
});
