/**
 * The streaming multipart reader (`src/files/multipart.ts`): each file part
 * spooled to its own file and measured as it arrives, the bounds held while
 * streaming, and the spool removed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultipartError, multipartBoundary, parseMultipart } from "../../../src/files/multipart.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function form(parts: Array<[string, string | File]>): Request {
  const fd = new FormData();
  for (const [k, v] of parts) fd.append(k, v);
  return new Request("http://x/", { method: "POST", body: fd });
}

async function parse(req: Request, limits: Partial<Parameters<typeof parseMultipart>[2]> = {}) {
  const spoolDir = mkdtempSync(join(tmpdir(), "nb-multipart-"));
  dirs.push(spoolDir);
  const boundary = multipartBoundary(req.headers.get("content-type"));
  if (!boundary) throw new Error("no boundary");
  return parseMultipart(req.body, boundary, {
    spoolDir,
    maxFiles: 10,
    maxFileSize: 1_000_000,
    maxTotalSize: 10_000_000,
    ...limits,
  });
}

describe("parseMultipart", () => {
  test("reads fields and spools each file whole, across chunk boundaries", async () => {
    const big = "A".repeat(300_000);
    const parsed = await parse(
      form([
        ["message", "hello"],
        ["files", new File([big], "a.txt", { type: "text/plain" })],
        ["files", new File(["tiny"], "b.typ")],
      ]),
    );
    expect(parsed.fields.get("message")).toBe("hello");
    expect(parsed.files.map((f) => [f.filename, f.size])).toEqual([
      ["a.txt", 300_000],
      ["b.typ", 4],
    ]);
    expect(readFileSync(parsed.files[0]!.path!, "utf-8")).toBe(big);
    const paths = parsed.files.map((f) => f.path!);
    await parsed.dispose();
    expect(paths.some((p) => existsSync(p))).toBe(false);
  });

  test("a file past the per-file limit is counted and not kept; files past the count are counted only", async () => {
    const parsed = await parse(
      form([
        ["files", new File(["0123456789"], "big.txt")],
        ["files", new File(["x"], "two.txt")],
        ["files", new File(["y"], "three.txt")],
      ]),
      { maxFileSize: 5, maxFiles: 2 },
    );
    expect(parsed.files.map((f) => f.size)).toEqual([10, 1, 1]);
    expect(parsed.files[2]!.path).toBeUndefined();
    await parsed.dispose();
  });

  test("only the named fields are files", async () => {
    const parsed = await parse(
      form([
        ["tags", new File(["x"], "t.txt")],
        ["file", new File(["y"], "f.txt")],
      ]),
      { fileFields: new Set(["file", "files"]) },
    );
    expect(parsed.files.map((f) => f.filename)).toEqual(["f.txt"]);
    await parsed.dispose();
  });

  test("a body past the total ends the read with 413, and keeps nothing", async () => {
    const err = await parse(form([["files", new File(["x".repeat(5000)], "a.txt")]]), {
      maxTotalSize: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultipartError);
    expect((err as MultipartError).status).toBe(413);
  });

  test("a truncated body is malformed", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zz" },
      body: '--zz\r\nContent-Disposition: form-data; name="message"\r\n\r\nhel',
    });
    const err = await parse(req).catch((e: unknown) => e);
    expect((err as MultipartError).status).toBe(400);
  });

  test("the boundary comes from the content type", () => {
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe("a b");
    expect(multipartBoundary("application/json")).toBeNull();
  });
});
