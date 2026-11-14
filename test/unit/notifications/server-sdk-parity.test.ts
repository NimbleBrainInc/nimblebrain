/**
 * The Python server SDK's outbox (`packages/server-sdk-py`, `[outbox]`) is the
 * server half of this notification protocol. It refuses at `emit` what this
 * host would trim or drop, so an envelope it accepts is rendered whole here.
 * The host drops an envelope it cannot hold and its poll moves past it, so an
 * envelope the SDK accepts and this parser drops is a lost notification.
 *
 * Two checks hold that. The SDK's limits are read from its source and compared
 * with this host's. And the boundary cases in the SDK's
 * `tests/outbox/fixtures/host_parity.json` go through this host's real parser:
 * the SDK's suite asserts its own verdict on each and that the poll renders an
 * accepted one as the case's envelope plus a cursor, and this one asserts the
 * host's verdict on that same occurrence.
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
  parseNotificationEnvelope,
} from "../../../src/notifications/envelope.ts";
import {
  DEFAULT_NOTIFICATION_LEVEL,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_LEVELS,
  NOTIFICATION_META_KEY,
  NOTIFICATION_SUBJECT_MAX,
  NOTIFICATION_TITLE_MAX,
} from "../../../src/notifications/types.ts";

const SDK = join(import.meta.dir, "../../../packages/server-sdk-py");
const OUTBOX = join(SDK, "src/nimblebrain_server_sdk/outbox");

interface ParityCase {
  case: string;
  envelope: Record<string, unknown> & { data: Record<string, unknown> };
  pad?: number;
  sdk: "accept" | "refuse";
  host: "keep" | "drop";
}

const CASES: ParityCase[] = JSON.parse(
  readFileSync(join(SDK, "tests/outbox/fixtures/host_parity.json"), "utf8"),
);

/** What the SDK's poll serves for a case: its envelope, padded, with a longest-possible cursor. */
function occurrence(parity: ParityCase): Record<string, unknown> {
  const data =
    parity.pad === undefined
      ? parity.envelope.data
      : { ...parity.envelope.data, s: "a".repeat(parity.pad) };
  return { ...parity.envelope, data, cursor: "x".repeat(NOTIFICATION_CURSOR_MAX) };
}

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

describe("what the server SDK accepts, this host keeps", () => {
  test.each(CASES.map((parity) => [parity.case, parity] as const))("%s", (_, parity) => {
    const kept = parseNotificationEnvelope(occurrence(parity)) !== null;
    expect(kept ? "keep" : "drop").toBe(parity.host);
  });

  test("no case the SDK accepts is one this host drops", () => {
    const lost = CASES.filter((parity) => parity.sdk === "accept" && parity.host === "drop");
    expect(lost.map((parity) => parity.case)).toEqual([]);
  });
});
