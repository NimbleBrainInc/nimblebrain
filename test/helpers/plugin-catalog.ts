/**
 * Plugin archive fixtures: the zip writer, the manifest `$schema`, a bound
 * `SKILL.md`, and the address every test process points the default catalog
 * at.
 */

import { deflateRawSync } from "node:zlib";

/**
 * The default catalog's base URL every test process starts pointed at
 * (`test/preload.ts`): a local port that refuses, so no test reaches the real
 * catalog by default.
 */
export const OFFLINE_PLUGIN_CATALOG_URL = "http://127.0.0.1:9";

/** The `$schema` every Agent Plugins 1.0.0 `plugin.json` carries, as the catalog build writes it. */
export const AGENT_PLUGINS_MANIFEST_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

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
