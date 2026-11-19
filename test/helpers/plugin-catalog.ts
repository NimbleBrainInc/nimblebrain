/**
 * A plugin catalog served from memory, in the shape the NimbleBrain catalog
 * publishes (ADR-0068): a NimbleBrain index kept under its sha256, and one zip
 * per plugin kept under its own. Tests build one, inject its `fetch`, and pin
 * the runtime to its `pin`.
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { fakeFetch } from "./fake-fetch.ts";

export const TEST_CATALOG_URL = "https://catalog.test";

export interface FixturePlugin {
  name: string;
  /** `extensions["ai.nimblebrain"].servers`: key → registry name. */
  servers: Record<string, string>;
  /** Skill folder → SKILL.md text. */
  skills?: Record<string, string>;
}

export interface FixtureCatalog {
  /** sha256 of the index. */
  pin: string;
  /** sha256 of each plugin's archive, by plugin name. */
  digests: Record<string, string>;
  /** Every URL the catalog serves, with its bytes. */
  objects: Map<string, Uint8Array>;
  /** A fetch over `objects` (404 for anything else) that records each URL it was asked for. */
  fetch: typeof fetch;
  requests: string[];
}

/** A SKILL.md bound to plugin server `server`. */
export function boundSkill(name: string, server: string, body = `Use ${name} carefully.`): string {
  return `---
name: ${name}
description: How to use ${name}.
metadata:
  nimblebrain:
    server: ${server}
---

${body}
`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildCatalog(
  plugins: FixturePlugin[],
  opts: { url?: string; name?: string } = {},
): FixtureCatalog {
  const base = opts.url ?? TEST_CATALOG_URL;
  const objects = new Map<string, Uint8Array>();
  const digests: Record<string, string> = {};
  const entries = plugins.map((plugin) => {
    const files: Record<string, string> = {
      "plugin.json": JSON.stringify({
        name: plugin.name,
        extensions: { "ai.nimblebrain": { servers: plugin.servers } },
      }),
    };
    for (const [skill, text] of Object.entries(plugin.skills ?? {})) {
      files[`skills/${skill}/SKILL.md`] = text;
    }
    const archive = zip(files);
    const digest = sha256(archive);
    digests[plugin.name] = digest;
    const url = `${base}/plugins/${plugin.name}/${digest}.zip`;
    objects.set(url, archive);
    return { name: plugin.name, source: { source: "archive", url, sha256: digest } };
  });
  const index = new TextEncoder().encode(
    JSON.stringify({ name: opts.name ?? "nimblebrain", plugins: entries }),
  );
  const pin = sha256(index);
  objects.set(`${base}/nimblebrain/marketplace/${pin}.json`, index);

  const requests: string[] = [];
  return {
    pin,
    digests,
    objects,
    requests,
    fetch: fakeFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      const body = objects.get(url);
      return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
    }),
  };
}

/** A zip of `files`, deflated, with the plugin root at the top. */
export function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = new TextEncoder().encode(path);
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const packed = deflateRawSync(data);
    const crc = Bun.hash.crc32(data);

    const local = new Uint8Array(30 + name.length + packed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(packed, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
