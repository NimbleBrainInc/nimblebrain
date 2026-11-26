import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHostConstants,
  HOST_CONSTANTS_VERSION,
  serializeHostConstants,
} from "../../../web/src/bridge/host-constants.ts";

/**
 * Drift guard: `schemas/host-bridge/v1/constants.json` is the document other
 * repos test their copies of the bridge's identifiers and limits against, so it
 * must say what the bridge's source says. The comparison is made in memory
 * against the committed bytes, so it needs no git and catches a file that was
 * never regenerated or was edited by hand.
 */
const COMMITTED = resolve(import.meta.dir, "../../../schemas/host-bridge/v1/constants.json");

describe("host bridge constants document", () => {
  test("the committed file is what the bridge's source generates", () => {
    const committed = readFileSync(COMMITTED, "utf8");
    if (committed !== serializeHostConstants()) {
      throw new Error(
        "schemas/host-bridge/v1/constants.json differs from the bridge's source. " +
          "Run `bun run gen:host-constants` and commit the result.",
      );
    }
  });

  test("generation is deterministic", () => {
    expect(serializeHostConstants()).toBe(serializeHostConstants());
  });

  test("the document leads with the version a reader checks", () => {
    expect(Object.keys(buildHostConstants())[0]).toBe("version");
    expect(buildHostConstants().version).toBe(HOST_CONSTANTS_VERSION);
  });
});
