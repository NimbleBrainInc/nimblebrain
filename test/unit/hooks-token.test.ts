import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  HOOK_TOKEN_KEY_ENV,
  buildHookUrl,
  newDeliveryId,
  newKid,
  readHookIdentity,
  readHookTokenKeys,
} from "../../src/hooks/token.ts";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const TID = "tenant-a";
describe("hook key provisioning", () => {
  test("absent key means no hooks door, not an error", () => {
    expect(readHookTokenKeys({})).toBeUndefined();
    expect(readHookIdentity({})).toBeUndefined();
  });

  test("a key present but too short fails loudly at boot", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: short })).toThrow(/32 bytes/);
  });

  test.each([
    ["all zeros", Buffer.alloc(32, 0)],
    ["all 0xff", Buffer.alloc(32, 0xff)],
  ])("a placeholder key (%s) fails loudly at boot", (_label, buf) => {
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: buf.toString("base64") })).toThrow(
      /placeholder/,
    );
  });

  test("a valid key with no tenant id still means no hooks door", () => {
    expect(readHookIdentity({ [HOOK_TOKEN_KEY_ENV]: KEY.toString("base64") })).toBeUndefined();
  });

  test("both halves present yields an identity", () => {
    const identity = readHookIdentity({
      [HOOK_TOKEN_KEY_ENV]: KEY.toString("base64"),
      NB_TENANT_ID: TID,
    });
    expect(identity?.tid).toBe(TID);
    expect(identity?.key.equals(KEY)).toBe(true);
  });
});

describe("kid + url", () => {
  test("kids are unique", () => {
    const kids = new Set(Array.from({ length: 200 }, () => newKid()));
    expect(kids.size).toBe(200);
  });

  test("the URL is the origin, the prefix, and one opaque segment", () => {
    process.env.NB_PUBLIC_ORIGIN = "https://runtime.example";
    try {
      expect(buildHookUrl("abc123")).toBe("https://runtime.example/v1/hooks/abc123");
    } finally {
      delete process.env.NB_PUBLIC_ORIGIN;
    }
  });

  test("a minted URL fits the shortest webhook column a vendor is known to have", () => {
    // A vendor stores a delivery URL in 255 characters and answers a 500 above
    // it. The previous URL ran past 330 and could not be registered at all. The
    // margin has to survive a long tenant hostname, not just today's.
    process.env.NB_PUBLIC_ORIGIN = `https://${"a".repeat(63)}.platform.example.com`;
    try {
      const url = buildHookUrl(newDeliveryId());
      expect(url.length).toBeLessThanOrEqual(255);
    } finally {
      delete process.env.NB_PUBLIC_ORIGIN;
    }
  });

  test("delivery ids do not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDeliveryId()));
    expect(ids.size).toBe(200);
  });

  test("a delivery id is opaque — it encodes nothing about who it is for", () => {
    // The old URL carried tenant, workspace, connector and vendor in clear
    // before its token began. This carries none of them: a URL seen in a vendor
    // dashboard or a proxy log discloses nothing but the runtime's own host.
    const id = newDeliveryId();
    for (const leak of ["tenant", "ws_", "mcp", "vendor", "connector"]) {
      expect(id.toLowerCase()).not.toContain(leak);
    }
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("the key ring is configuration, and is validated at boot", () => {
  test("a ring of only separators fails at boot, not at the first mint", () => {
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: " , , " })).toThrow(/names no key/);
  });

  test("an unbounded ring is refused — every entry still opens live URLs", () => {
    const four = [KEY, OTHER_KEY, randomBytes(32), randomBytes(32)]
      .map((k) => k.toString("base64"))
      .join(",");
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: four })).toThrow(/at most/);
  });

  test.each([
    ["newline", "\n"],
    ["space", " "],
    ["semicolon", ";"],
  ])("a ring separated by a %s is refused, not silently read as one key", (_label, sep) => {
    // The decoder truncates at the first character outside the alphabet rather
    // than failing, and a 32-byte key ends in padding — so without the round-trip
    // check this parses as ONE key, at full length, and the overlap the operator
    // thinks they created does not exist.
    const ring = `${KEY.toString("base64")}${sep}${OTHER_KEY.toString("base64")}`;
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: ring })).toThrow(/valid base64/);
  });

  test("a comma-separated ring is unaffected by the round-trip check", () => {
    const ring = `${KEY.toString("base64")}, ${OTHER_KEY.toString("base64")}`;
    const keys = readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: ring });
    expect(keys).toHaveLength(2);
    expect(keys?.[0].equals(KEY)).toBe(true);
    expect(keys?.[1].equals(OTHER_KEY)).toBe(true);
  });

  test("a malformed key anywhere in the ring fails at boot, not just the first", () => {
    const ring = `${KEY.toString("base64")},${randomBytes(16).toString("base64")}`;
    expect(() => readHookTokenKeys({ [HOOK_TOKEN_KEY_ENV]: ring })).toThrow(/32 bytes/);
  });

});
