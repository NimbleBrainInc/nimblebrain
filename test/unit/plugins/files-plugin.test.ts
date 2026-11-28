/**
 * The files plugin (`packages/files/`) on what the black-box runner cannot drive: the store's
 * commit point and crash recovery, an upload's one commit, the upload windows on a clock the test sets (completion
 * within and past the grace, an abandoned upload's bytes removed, a repeat answer once its
 * file is gone), the transfer handler's grammar, extraction of DOCX and XLSX with its
 * budgets, and internal failures carrying no detail. Calls go through the server's own
 * dispatch (`callTool`) and the transfer handler, in process.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutText, extractText } from "../../../packages/files/src/extract.ts";
import { fileKind, recordedType } from "../../../packages/files/src/mime.ts";
import { COMPLETION_GRACE_MS } from "../../../packages/files/src/private.ts";
import { callTool, envOf } from "../../../packages/files/src/server.ts";
import { Store } from "../../../packages/files/src/store.ts";
import { parseRange, Transfers } from "../../../packages/files/src/transfer.ts";
import {
  buildZip,
  DOCX_MIME,
  docxWithParagraphs,
  XLSX_MIME,
  xlsxWithRows,
} from "../../helpers/document-fixtures.ts";

const WS = "ws_f1f1f1f1f1f1f1f1";
const OWNER = "usr_files";
const ORIGIN = "http://127.0.0.1:9";
const T0 = Date.parse("2031-03-01T00:00:00.000Z");

let dir: string;
let clock: number;
let store: Store;
let transfers: Transfers;

// biome-ignore lint/suspicious/noExplicitAny: answers are read field by field in assertions
type Answer = Record<string, any>;
type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

const env = () =>
  envOf({ store, transfers, now: () => clock, uploadTtlMs: 60_000, downloadTtlMs: 30_000 });
const host = { principal: "host" as const, workspaceId: WS, ownerId: OWNER };
const person = { ...host, principal: "person" as const };

async function call(tool: string, args: Record<string, unknown>, ctx: object = host) {
  return (await callTool(env(), tool, args, ctx)) as Result;
}
async function ok(tool: string, args: Record<string, unknown>, ctx: object = host) {
  const r = await call(tool, args, ctx);
  if (r.isError) throw new Error(`${tool}: ${r.content[0]?.text}`);
  return r.structuredContent as Answer;
}
const code = (r: Result) => JSON.parse(r.content[0]?.text ?? "{}").code as string;

function fresh(): void {
  store = new Store(dir);
  transfers = new Transfers({ store, now: () => clock, origin: () => ORIGIN });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "files-plugin-"));
  clock = T0;
  fresh();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const wsDir = () => join(dir, "workspaces", WS);

/** Open an upload, PUT `body` through the transfer handler, and answer its id. */
async function uploaded(body: string, meta: Record<string, unknown> = {}) {
  const begun = await ok("begin_upload", {
    version: "1.0",
    filename: "u.txt",
    mimeType: "text/plain",
    size: Buffer.byteLength(body),
    source: "app",
    ...meta,
  });
  const res = await transfers.handle(new Request(begun.url, { method: "PUT", body }));
  expect(res.status).toBe(204);
  return begun as { uploadId: string; url: string; expiresAt: string };
}

describe("the store's commit point", () => {
  test("a body written without its commit is removed when the workspace loads", async () => {
    const made = await ok("create", {
      manifest: { filename: "a.txt", mimeType: "text/plain" },
      body: "kept",
      encoding: "text",
    });
    const bodies = join(wsDir(), "bodies");
    writeFileSync(join(bodies, "fl_orphan"), "no record names me");
    writeFileSync(join(bodies, `${made.id}.tmp-1`), "torn");
    writeFileSync(join(wsDir(), "state.json.tmp-1"), "{");
    fresh();
    expect((await ok("list", {}, person)).total).toBe(1);
    expect(readdirSync(bodies)).toEqual([made.id]);
    expect(existsSync(join(wsDir(), "state.json.tmp-1"))).toBe(false);
  });

  test("a delete that crashed after its commit leaves no body behind on load", async () => {
    const made = await ok("create", {
      manifest: { filename: "a.txt", mimeType: "text/plain" },
      body: "gone",
      encoding: "text",
    });
    const kept = join(dir, "kept-body");
    writeFileSync(kept, "gone");
    await ok("delete", { id: made.id }, person);
    // As if the unlink after the commit never ran.
    writeFileSync(join(wsDir(), "bodies", made.id), "gone");
    fresh();
    await ok("list", {}, person);
    expect(existsSync(join(wsDir(), "bodies", made.id))).toBe(false);
  });

  test("a call that throws commits nothing and is not seen", async () => {
    await ok("create_folder", { manifest: { name: "A" } }, person);
    const r = await call("create_folder", { manifest: { name: "a" } }, person);
    expect(code(r)).toBe("conflict");
    fresh();
    expect((await ok("list", { folderId: "root" }, person)).folders).toHaveLength(1);
  });

  test("a restart removes every upload's body; an open upload is gone and begins again", async () => {
    const open = await uploaded("still open");
    const done = await uploaded("completed");
    await ok("complete_upload", { version: "1.0", uploadId: done.uploadId });
    // As if the unlink after the completion's commit never ran.
    writeFileSync(join(wsDir(), "uploads", done.uploadId), "completed");
    writeFileSync(join(wsDir(), "uploads", `${open.uploadId}.abc.tmp`), "a PUT cut short");
    fresh();
    await ok("list", {}, person);
    expect(readdirSync(join(wsDir(), "uploads"))).toEqual([]);
    expect(code(await call("complete_upload", { version: "1.0", uploadId: open.uploadId }))).toBe(
      "upload_not_found",
    );
    const again = await uploaded("still open");
    await ok("complete_upload", { version: "1.0", uploadId: again.uploadId });
    expect((await ok("list", {}, person)).total).toBe(2);
  });
});

/**
 * Record, in order, the directory-entry operations and fsyncs `fn` makes: each `fsync` names
 * the path its descriptor was opened on.
 */
async function fsOps(fn: () => Promise<unknown>): Promise<string[]> {
  const ops: string[] = [];
  const paths = new Map<number, string>();
  const rel = (p: fs.PathLike) => String(p).slice(wsDir().length + 1) || ".";
  const real = {
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    renameSync: fs.renameSync,
    linkSync: fs.linkSync,
    rmSync: fs.rmSync,
  };
  const spies = [
    spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: [fs.OpenMode?]) => {
      const fd = real.openSync(p, ...rest);
      paths.set(fd, rel(p));
      return fd;
    }) as typeof fs.openSync),
    spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      ops.push(`fsync ${paths.get(fd)}`);
      real.fsyncSync(fd);
    }),
    spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      ops.push(`rename ${rel(to)}`);
      real.renameSync(from, to);
    }),
    spyOn(fs, "linkSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      ops.push(`link ${rel(to)}`);
      real.linkSync(from, to);
    }),
    spyOn(fs, "rmSync").mockImplementation((p: fs.PathLike, o?: fs.RmOptions) => {
      ops.push(`rm ${rel(p)}`);
      real.rmSync(p, o);
    }),
  ];
  try {
    await fn();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return ops;
}

describe("the store's durable order", () => {
  test("completion makes the body's name durable, then the state, then unlinks", async () => {
    const begun = await uploaded("durable");
    let fileId = "";
    const ops = await fsOps(async () => {
      fileId = (await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId })).file.id;
    });
    const at = (op: string) => {
      const i = ops.indexOf(op);
      expect(i, op).toBeGreaterThanOrEqual(0);
      return i;
    };
    const link = at(`link bodies/${fileId}`);
    const bodies = at("fsync bodies");
    const state = at("rename state.json");
    const dirSync = ops.indexOf("fsync .", state);
    const unlink = at(`rm uploads/${begun.uploadId}`);
    expect(link).toBeLessThan(bodies);
    expect(bodies).toBeLessThan(state);
    expect(dirSync).toBeGreaterThan(state);
    expect(dirSync).toBeLessThan(unlink);
  });

  test("a delete makes the state durable before it unlinks the body", async () => {
    const made = await ok("create", {
      manifest: { filename: "a.txt", mimeType: "text/plain" },
      body: "gone",
      encoding: "text",
    });
    const ops = await fsOps(() => ok("delete", { id: made.id }, person));
    const state = ops.indexOf("rename state.json");
    const dirSync = ops.indexOf("fsync .", state);
    expect(state).toBeGreaterThanOrEqual(0);
    expect(dirSync).toBeGreaterThan(state);
    expect(dirSync).toBeLessThan(ops.indexOf(`rm bodies/${made.id}`));
  });

  test("a create makes its body's name durable before the state names it", async () => {
    let id = "";
    const ops = await fsOps(async () => {
      id = (
        await ok("create", {
          manifest: { filename: "a.txt", mimeType: "text/plain" },
          body: "new",
          encoding: "text",
        })
      ).id;
    });
    const body = ops.indexOf(`rename bodies/${id}`);
    const bodies = ops.indexOf("fsync bodies", body);
    expect(body).toBeGreaterThanOrEqual(0);
    expect(bodies).toBeGreaterThan(body);
    expect(bodies).toBeLessThan(ops.indexOf("rename state.json"));
  });
});

const stateWritesOf = (ops: string[]) => ops.filter((op) => op === "rename state.json").length;

describe("an upload's one commit", () => {
  const stateWrites = stateWritesOf;

  test("begin_upload writes nothing; complete_upload writes the state once", async () => {
    let begun: Answer = {};
    const opening = await fsOps(async () => {
      begun = await ok("begin_upload", {
        version: "1.0",
        filename: "u.txt",
        mimeType: "text/plain",
        size: 3,
        source: "app",
      });
    });
    expect(opening).toEqual([]);
    expect(existsSync(join(wsDir(), "state.json"))).toBe(false);
    const res = await transfers.handle(new Request(begun.url, { method: "PUT", body: "one" }));
    expect(res.status).toBe(204);
    const completing = await fsOps(() =>
      ok("complete_upload", { version: "1.0", uploadId: begun.uploadId }),
    );
    expect(stateWrites(completing)).toBe(1);
    const repeating = await fsOps(() =>
      ok("complete_upload", { version: "1.0", uploadId: begun.uploadId }),
    );
    expect(stateWrites(repeating)).toBe(0);
  });

  test("a burst of uploads leaves state that grows with its files alone", async () => {
    const stateSize = () => fs.statSync(join(wsDir(), "state.json")).size;
    const burst = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const begun = await uploaded(`body ${i}`, { tags: ["burst"] });
        await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
      }
    };
    await burst(20);
    const twenty = stateSize();
    await burst(20);
    const forty = stateSize();
    const state = JSON.parse(fs.readFileSync(join(wsDir(), "state.json"), "utf-8"));
    expect(Object.keys(state)).toEqual(["files", "folders", "completed"]);
    expect(Object.keys(state.completed)).toHaveLength(40);
    for (const done of Object.values(state.completed)) {
      expect(Object.keys(done as object).sort()).toEqual([
        "expiresAt",
        "fileId",
        "folderId",
        "tags",
      ]);
    }
    // Linear: the second twenty add what the first did, give or take an id's digits.
    expect(Math.abs(forty - 2 * twenty)).toBeLessThan(twenty * 0.05);
    // A completed upload keeps no copy of its file's record: less than its row holds.
    const perFile = JSON.stringify(Object.entries(state.files)[0]).length;
    const perUpload = JSON.stringify(Object.entries(state.completed)[0]).length;
    expect(perUpload).toBeLessThan(perFile * 0.6);
  });
});

describe("upload windows, on the plugin's clock", () => {
  test("a body PUT in time completes up to 300 s past expiresAt, and not after", async () => {
    const a = await uploaded("within");
    const b = await uploaded("past");
    const expiresAt = Date.parse(a.expiresAt);
    clock = expiresAt + COMPLETION_GRACE_MS;
    await ok("complete_upload", { version: "1.0", uploadId: a.uploadId });
    clock = Date.parse(b.expiresAt) + COMPLETION_GRACE_MS + 1;
    expect(code(await call("complete_upload", { version: "1.0", uploadId: b.uploadId }))).toBe(
      "upload_not_found",
    );
  });

  test("a PUT after expiresAt is refused and stores nothing", async () => {
    const begun = await ok("begin_upload", {
      version: "1.0",
      filename: "late.txt",
      mimeType: "text/plain",
      size: 4,
      source: "app",
    });
    clock = Date.parse(begun.expiresAt);
    const res = await transfers.handle(new Request(begun.url, { method: "PUT", body: "late" }));
    expect(res.status).toBe(404);
    expect(code(await call("complete_upload", { version: "1.0", uploadId: begun.uploadId }))).toBe(
      "upload_incomplete",
    );
  });

  test("an abandoned upload is retired past its window, with its bytes", async () => {
    const begun = await uploaded("abandoned");
    expect(readdirSync(join(wsDir(), "uploads"))).toEqual([begun.uploadId]);
    clock = Date.parse(begun.expiresAt) + COMPLETION_GRACE_MS + 1;
    await ok("list", {}, person);
    expect(readdirSync(join(wsDir(), "uploads"))).toEqual([]);
  });

  test("a completed upload's repeat answers the first until its file is deleted", async () => {
    const begun = await uploaded("repeat");
    const first = await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
    expect(await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId })).toEqual(
      first,
    );
    await ok("delete", { id: first.file.id }, person);
    expect(code(await call("complete_upload", { version: "1.0", uploadId: begun.uploadId }))).toBe(
      "upload_not_found",
    );
  });

  test("a repeat answers the first after its file is tagged and moved, and after a restart", async () => {
    const begun = await uploaded("replay");
    const first = await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
    const folder = await ok("create_folder", { manifest: { name: "Elsewhere" } }, person);
    await ok("tag", { id: first.file.id, add: ["later"] }, person);
    await ok("move", { ids: [first.file.id], folderId: folder.id }, person);
    expect(await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId })).toEqual(
      first,
    );
    fresh();
    expect(await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId })).toEqual(
      first,
    );
    clock = Date.parse(begun.expiresAt) + COMPLETION_GRACE_MS + 1;
    expect(code(await call("complete_upload", { version: "1.0", uploadId: begun.uploadId }))).toBe(
      "upload_not_found",
    );
  });

  test("a completed upload is retired past its window, and leaves the state with a commit", async () => {
    const begun = await uploaded("retired");
    await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
    const kept = () =>
      Object.keys(JSON.parse(fs.readFileSync(join(wsDir(), "state.json"), "utf-8")).completed);
    expect(kept()).toEqual([begun.uploadId]);
    clock = Date.parse(begun.expiresAt) + COMPLETION_GRACE_MS + 1;
    expect(stateWritesOf(await fsOps(() => ok("list", {}, person)))).toBe(0);
    await ok("create_folder", { manifest: { name: "Commit" } }, person);
    expect(kept()).toEqual([]);
  });

  test("a call that throws while a PUT streams leaves the PUT's body in place", async () => {
    const begun = await ok("begin_upload", {
      version: "1.0",
      filename: "slow.txt",
      mimeType: "text/plain",
      size: 4,
      source: "app",
    });
    let push!: (chunk: Uint8Array | null) => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("sl"));
        push = (chunk) => (chunk ? controller.enqueue(chunk) : controller.close());
      },
    });
    const put = transfers.handle(new Request(begun.url, { method: "PUT", body }));
    await Bun.sleep(10);
    expect(readdirSync(join(wsDir(), "uploads")).some((f) => f.endsWith(".tmp"))).toBe(true);
    // A rejected call evicts the workspace; the next call reloads it.
    expect(code(await call("delete", { id: "fl_absent" }, person))).toBe("file_not_found");
    await ok("list", {}, person);
    push(new TextEncoder().encode("ow"));
    push(null);
    expect((await put).status).toBe(204);
    const done = await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
    expect(done.file.size).toBe(4);
  });

  test("a PUT longer than the declared size is refused and stores nothing", async () => {
    const begun = await ok("begin_upload", {
      version: "1.0",
      filename: "x.txt",
      mimeType: "text/plain",
      size: 3,
      source: "app",
    });
    const res = await transfers.handle(new Request(begun.url, { method: "PUT", body: "four" }));
    expect(res.status).toBe(413);
    expect(readdirSync(join(wsDir(), "uploads"))).toEqual([]);
  });

  test("a download URL stops at its expiry, and after its file is deleted", async () => {
    const made = await ok(
      "create",
      { manifest: { filename: "d.txt", mimeType: "text/plain" }, body: "body", encoding: "text" },
      person,
    );
    const resolved = await ok("resolve", { version: "1.0", uris: [`files://${made.id}`] });
    const url = resolved.files[0].download.url as string;
    expect((await transfers.handle(new Request(url))).status).toBe(200);
    clock = Date.parse(resolved.files[0].download.expiresAt);
    expect((await transfers.handle(new Request(url))).status).toBe(404);
    clock = T0;
    const again = await ok("resolve", { version: "1.0", uris: [`files://${made.id}`] });
    await ok("delete", { id: made.id }, person);
    expect((await transfers.handle(new Request(again.files[0].download.url))).status).toBe(404);
  });
});

describe("the transfer handler", () => {
  test("parses one bytes range, refuses what it cannot satisfy", () => {
    expect(parseRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
  });

  test("answers a query string, a wrong secret and an unknown id alike: 404", async () => {
    const made = await ok(
      "create",
      { manifest: { filename: "q.txt", mimeType: "text/plain" }, body: "q", encoding: "text" },
      person,
    );
    const resolved = await ok("resolve", { version: "1.0", uris: [`files://${made.id}`] });
    const url = resolved.files[0].download.url as string;
    const [base, secret] = url.split(".") as [string, string];
    for (const bad of [`${url}?x=1`, `${base}.${secret.slice(0, -1)}`, `${ORIGIN}/t/abc.def`]) {
      const res = await transfers.handle(new Request(bad));
      expect(res.status).toBe(404);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("accepts only the token as issued, not another spelling of its secret", async () => {
    const made = await ok(
      "create",
      { manifest: { filename: "s.txt", mimeType: "text/plain" }, body: "s", encoding: "text" },
      person,
    );
    const resolved = await ok("resolve", { version: "1.0", uris: [`files://${made.id}`] });
    const url = resolved.files[0].download.url as string;
    expect((await transfers.handle(new Request(url))).status).toBe(200);
    const stem = url.slice(0, -1);
    const secret = url.slice(url.lastIndexOf(".") + 1);
    const bytes = Buffer.from(secret, "base64url");
    // The last of 43 characters carries 2 unused bits: 3 other characters decode alike.
    const aliases = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"]
      .map((ch) => stem + ch)
      .filter(
        (u) => u !== url && Buffer.from(u.slice(u.lastIndexOf(".") + 1), "base64url").equals(bytes),
      );
    expect(aliases).toHaveLength(3);
    for (const bad of [...aliases, `${url}=`, `${url}%21`]) {
      expect((await transfers.handle(new Request(bad))).status).toBe(404);
    }
  });
});

describe("extraction", () => {
  test("a DOCX reads as Markdown and an XLSX's first sheet as CSV", async () => {
    const docx = await extractText(docxWithParagraphs(3), DOCX_MIME);
    expect(docx?.text.length).toBeGreaterThan(0);
    const xlsx = await extractText(xlsxWithRows(3), XLSX_MIME);
    expect(xlsx?.text.split("\n")).toHaveLength(3);
  });

  test("an OOXML body past its budget is refused before parsing", async () => {
    const bomb = buildZip({ "word/document.xml": "<w:p/>".repeat(2_000_000) });
    expect(await extractText(bomb, DOCX_MIME)).toBeNull();
  });

  test("text is cut at a character boundary", () => {
    expect(cutText("aé✓", 2)).toEqual({ text: "a", truncated: true });
    expect(cutText("aé✓", 6)).toEqual({ text: "aé✓", truncated: false });
  });

  test("types follow the contract's tables", () => {
    expect(recordedType("a.typ", "application/octet-stream")).toBe("text/plain");
    expect(recordedType("Makefile", "")).toBe("application/octet-stream");
    expect(fileKind("IMAGE/PNG; x=1")).toBe("image");
    expect(fileKind("application/x-unknown")).toBe("other");
  });
});

describe("failures", () => {
  test("an internal failure answers internal_error with no detail of the medium", async () => {
    const begun = await uploaded("x");
    // A file where the bodies directory belongs: the commit cannot place the body.
    rmSync(join(wsDir(), "bodies"), { recursive: true, force: true });
    writeFileSync(join(wsDir(), "bodies"), "in the way");
    const quiet = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const r = await call("complete_upload", { version: "1.0", uploadId: begun.uploadId });
      expect(code(r)).toBe("internal_error");
      expect(r.content[0]?.text).not.toContain(dir);
      expect(r.content[0]?.text).not.toContain("bodies");
    } finally {
      quiet.mockRestore();
    }
    // Nothing was committed: the upload is still open.
    rmSync(join(wsDir(), "bodies"), { force: true });
    await ok("complete_upload", { version: "1.0", uploadId: begun.uploadId });
  });
});
