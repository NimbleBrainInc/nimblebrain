/**
 * The Python server SDK's outbox (`packages/server-sdk-py`, `[outbox]`) is the
 * server half of this notification protocol. It refuses at `emit` what this
 * host would trim or drop, so an envelope it accepts is rendered whole here.
 * That holds only while its limits equal this host's, so this test reads the
 * SDK's constants from its source and fails when the two sides diverge.
 *
 * Read from source rather than by running Python: the unit suite needs no
 * interpreter, and the SDK's own suite runs from its wheel, where this host's
 * source is absent, so the check can live only on this side.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOTIFICATION_CURSOR_MAX,
  NOTIFICATION_ENVELOPE_MAX_BYTES,
  NOTIFICATION_FORBIDDEN_LINK_SCHEMES,
  NOTIFICATION_ID_MAX,
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_NAME_MAX,
} from "../../../src/notifications/envelope.ts";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_LEVELS,
  NOTIFICATION_META_KEY,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_TITLE_MAX,
} from "../../../src/notifications/types.ts";

const OUTBOX = join(
  import.meta.dir,
  "../../../packages/server-sdk-py/src/nimblebrain_server_sdk/outbox",
);

/**
 * The right-hand side of a module-level `NAME = ...` assignment, read as the
 * few literal forms the SDK uses for these constants: an integer product
 * (`64 * 1024`), a string, or a tuple or frozenset of strings. Anything else
 * fails, so a constant rewritten into a form this cannot read is noticed.
 */
function pythonConstant(file: string, name: string): number | string | string[] {
  const source = readFileSync(join(OUTBOX, file), "utf8");
  const match = new RegExp(`^${name} = (.+)$`, "m").exec(source);
  if (!match) throw new Error(`${name} is not assigned at module level in ${file}`);
  const value = match[1]!.trim();
  if (/^\d[\d_]*( \* \d[\d_]*)*$/.test(value)) {
    return value
      .split(" * ")
      .map((factor) => Number(factor.replaceAll("_", "")))
      .reduce((product, factor) => product * factor, 1);
  }
  const string = /^"([^"]*)"$/.exec(value);
  if (string) return string[1]!;
  if (/^(\(|frozenset\(\{)("[^"]*",? ?)+(\)|\}\))$/.test(value)) {
    return [...value.matchAll(/"([^"]*)"/g)].map((item) => item[1]!);
  }
  throw new Error(`${name} in ${file} is not a literal this test reads: ${value}`);
}

describe("the server SDK's outbox limits equal this host's", () => {
  test.each([
    ["TITLE_MAX", NOTIFICATION_TITLE_MAX],
    ["BODY_MAX", NOTIFICATION_BODY_MAX],
    ["SUBJECT_MAX", NOTIFICATION_SUBJECT_MAX],
    ["NAME_MAX", NOTIFICATION_NAME_MAX],
    ["EVENT_ID_MAX", NOTIFICATION_ID_MAX],
    ["LINK_MAX", NOTIFICATION_LINK_MAX],
    ["ENVELOPE_MAX_BYTES", NOTIFICATION_ENVELOPE_MAX_BYTES],
  ] as const)("envelope.%s", (name, host) => {
    expect(pythonConstant("envelope.py", name)).toBe(host);
  });

  test("cursor.MAX_CURSOR_LENGTH", () => {
    expect(pythonConstant("cursor.py", "MAX_CURSOR_LENGTH")).toBe(NOTIFICATION_CURSOR_MAX);
  });

  test("the _meta key", () => {
    expect(pythonConstant("envelope.py", "NOTIFICATION_META_KEY")).toBe(NOTIFICATION_META_KEY);
  });

  test("the levels, in order, and the default", () => {
    expect(pythonConstant("envelope.py", "LEVELS")).toEqual([...NOTIFICATION_LEVELS]);
    expect(pythonConstant("envelope.py", "DEFAULT_LEVEL")).toBe(DEFAULT_NOTIFICATION_LEVEL);
  });

  test("the link schemes refused", () => {
    const sdk = pythonConstant("envelope.py", "FORBIDDEN_LINK_SCHEMES") as string[];
    expect([...sdk].sort()).toEqual([...NOTIFICATION_FORBIDDEN_LINK_SCHEMES].sort());
  });
});
