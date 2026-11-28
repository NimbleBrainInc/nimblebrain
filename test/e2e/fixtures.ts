/**
 * What the end-to-end suite feeds a runtime: a catalog it can browse and install
 * from, and the bytes of each attachment kind.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listingBytes } from "../helpers/ai-catalog.ts";
import { buildZip, DOCX_MIME, XLSX_MIME } from "../helpers/document-fixtures.ts";
import { artifactEntry, pluginZip, skillMd } from "../helpers/plugin-artifacts.ts";

// ── The catalog ─────────────────────────────────────────────────────────────

/** The catalog name, the part after `@` in an address. */
export const CATALOG_NAME = "e2e";
/** The fixture plugin's install address. */
export const PLUGIN_ADDRESS = `notes@${CATALOG_NAME}`;
/** Its one server's registry name, and the connection name it slugifies to. */
export const PLUGIN_SERVER = "test.e2e.notes/mcp";
export const PLUGIN_CONNECTION = "test-e2e-notes-mcp";
/** Its unbound skill, which install writes as a managed skill. */
export const PLUGIN_SKILL = "e2e-guide";
/** A second listed item, never installed: Browse shows both. */
export const OTHER_ADDRESS = `ledger@${CATALOG_NAME}`;

/** Where the fixture server keeps the paths it was asked for. */
export const REQUEST_LOG_PATH = "/__requests";

export interface CatalogFixture {
  /** The listing file, as a path catalog's `source`. */
  listingPath: string;
  /** The artifact server's base URL. */
  base: string;
  stop(): void;
}

/**
 * Serve two plugin artifacts and write a path listing naming them. The server
 * logs every path it is asked for and answers that log at `/__requests`, so a
 * scenario can tell whether Browse opened an artifact.
 */
export function startCatalogFixture(dir: string): CatalogFixture {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === REQUEST_LOG_PATH) return Response.json(requests);
      requests.push(path);
      const body = objects.get(path);
      return body ? new Response(body) : new Response("", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const publish = (name: string, bytes: Uint8Array, serverName: string) => {
    const { entry, path } = artifactEntry({
      name,
      bytes,
      base,
      servers: { [name]: { name: serverName, auth: "dcr" } },
    });
    objects.set(path, bytes);
    return entry;
  };
  const notes = pluginZip({
    name: "notes",
    servers: {
      notes: { name: PLUGIN_SERVER, url: "https://mcp.notes.invalid/mcp", meta: { auth: "dcr" } },
    },
    skills: {
      notes: skillMd("notes", { server: "notes", body: "Use the notes tools carefully." }),
      [PLUGIN_SKILL]: skillMd(PLUGIN_SKILL, { body: "E2E guide body." }),
    },
    starters: [{ title: "Find a note", text: "Help me find a note." }],
  });
  const ledger = pluginZip({
    name: "ledger",
    servers: {
      ledger: {
        name: "test.e2e.ledger/mcp",
        url: "https://mcp.ledger.invalid/mcp",
        meta: { auth: "dcr" },
      },
    },
  });
  const listingPath = join(dir, "ai-catalog.json");
  writeFileSync(
    listingPath,
    listingBytes([
      publish("notes", notes, PLUGIN_SERVER),
      publish("ledger", ledger, "test.e2e.ledger/mcp"),
    ]),
  );
  return { listingPath, base, stop: () => server.stop(true) };
}

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * A marker each document carries, so a scenario can find its text where it
 * landed. Letters and digits only: DOCX text reaches the model as markdown,
 * which escapes punctuation.
 */
export const MARK = {
  txt: "E2ETXT7a1",
  csv: "E2ECSV3c9",
  docx: "E2EDOCX5e2",
  xlsx: "E2EXLSX9b4",
  pdf: "E2EPDF2d8",
} as const;

export interface Attachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

function docx(text: string): Uint8Array {
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

function xlsx(text: string): Uint8Array {
  return buildZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`,
  });
}

/** A one-page PDF showing `text`. */
function pdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/** A valid 1x1 PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const text = (s: string) => new TextEncoder().encode(s);

/** One attachment of each kind the composer takes. */
export const ATTACHMENTS: Record<"txt" | "csv" | "docx" | "xlsx" | "pdf" | "png", Attachment> = {
  txt: {
    filename: "notes.txt",
    mimeType: "text/plain",
    bytes: text(`hello ${MARK.txt}\n`),
  },
  csv: {
    filename: "table.csv",
    mimeType: "text/csv",
    bytes: text(`name,value\n${MARK.csv},1\n`),
  },
  docx: { filename: "doc.docx", mimeType: DOCX_MIME, bytes: docx(MARK.docx) },
  xlsx: { filename: "sheet.xlsx", mimeType: XLSX_MIME, bytes: xlsx(MARK.xlsx) },
  pdf: {
    filename: "paper.pdf",
    mimeType: "application/pdf",
    bytes: pdf(MARK.pdf),
  },
  png: { filename: "dot.png", mimeType: "image/png", bytes: PNG },
};

/** A type the allowlist refuses. */
export const EXECUTABLE: Attachment = {
  filename: "tool.exe",
  mimeType: "application/x-msdownload",
  bytes: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3, 4]),
};
