/**
 * Builders for DOCX, XLSX, and PDF inputs to the text extractors: a minimal zip
 * writer, OOXML packages whose one large part repeats a row or paragraph, and a
 * PDF with one short line of text per page. A repeated part deflates by orders
 * of magnitude, which is the shape of a decompression bomb.
 */
import { deflateRawSync } from "node:zlib";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ZipOptions {
  /**
   * Write this as every entry's uncompressed size instead of the real one
   * (only the entry named `entry`, when given): `everywhere` in the local and
   * central headers, `central` in the central directory only.
   */
  understate?: { size: number; where: "everywhere" | "central"; entry?: string };
  /** Write this as the end record's entry counts instead of the real one. */
  entryCount?: number;
  /** Write `field` as every entry's extra field, in the local or central header. */
  extraField?: { field: Buffer; where: "local" | "central" };
}

/** A deflated zip of `entries`, in order. */
export function buildZip(entries: Record<string, string | Buffer>, options: ZipOptions = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = typeof content === "string" ? Buffer.from(content) : content;
    const deflated = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const crc = Bun.hash.crc32(raw);
    const lie =
      options.understate?.entry === undefined || options.understate.entry === name
        ? options.understate
        : undefined;
    const localSize = lie?.where === "everywhere" ? lie.size : raw.length;
    const centralSize = lie ? lie.size : raw.length;
    const empty = Buffer.alloc(0);
    const localExtra = options.extraField?.where === "local" ? options.extraField.field : empty;
    const centralExtra = options.extraField?.where === "central" ? options.extraField.field : empty;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(localSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, nameBytes, localExtra, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(centralSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes, centralExtra);

    offset += local.length + nameBytes.length + localExtra.length + deflated.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = options.entryCount ?? Object.keys(entries).length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const XLSX_ROW =
  '<row><c t="inlineStr"><is><t>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</t></is></c></row>';

/** An XLSX whose one sheet holds `rows` rows of one 40-character cell (88 bytes of XML each). */
export function xlsxWithRows(rows: number, options: ZipOptions = {}): Buffer {
  return buildZip(
    {
      "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${XLSX_ROW.repeat(rows)}</sheetData></worksheet>`,
    },
    options,
  );
}

const DOCX_PARAGRAPH = "<w:p><w:r><w:t>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</w:t></w:r></w:p>";

/**
 * A DOCX of `paragraphs` 40-character paragraphs (73 bytes of XML each), plus
 * any `extra` entries (e.g. media).
 */
export function docxWithParagraphs(
  paragraphs: number,
  options: ZipOptions & { extra?: Record<string, Buffer> } = {},
): Buffer {
  return buildZip(
    {
      "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${DOCX_PARAGRAPH.repeat(paragraphs)}</w:body></w:document>`,
      ...options.extra,
    },
    options,
  );
}

/**
 * An uncompressed PDF of `pages` pages in one flat page tree, each showing
 * `text` (no text when empty).
 */
export function pdfWithPages(pages: number, text = "a".repeat(80)): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
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
  return Buffer.from(out);
}
