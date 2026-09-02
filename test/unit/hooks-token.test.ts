import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { EnvelopeError } from "../../src/oauth/envelope.ts";
import { HOOK_TOKEN_KEY_ENV, buildHookUrl, newDeliveryId, newKid, openHookToken, openHookTokenForIdentity, readHookIdentity, readHookTokenKeys, sealHookToken } from "../../src/hooks/token.ts";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const TID = "tenant-a";
const FIELDS = {
  tid: TID,
  wid: "ws_abc123",
  connector: "acme-billing-mcp",
  vendor: "acme",
  kid: "hk_0123456789abcdef",
};

function expectRejected(fn: () => unknown): void {
  expect(fn).toThrow(EnvelopeError);
}

describe("hook token round-trip", () => {
  test("seals and opens under the same key and tenant", () => {
    const opened = openHookToken(sealHookToken(FIELDS, KEY), KEY, TID);
    expect(opened).toEqual({ v: 1, ...FIELDS });
  });

  test("rides the shared v1 MAC envelope wire format", () => {
    const parts = sealHookToken(FIELDS, KEY).split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
  });

  test("carries no expiry — retirement is the kid lookup, not a clock", () => {
    const [, payloadB64] = sealHookToken(FIELDS, KEY).split(".");
    const payload = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf8"));
    expect(payload.exp).toBeUndefined();
    expect(payload.iat).toBeUndefined();
  });
});

describe("hook token rejects forgeries", () => {
  test("a token sealed under another tenant's key does not open", () => {
    expectRejected(() => openHookToken(sealHookToken(FIELDS, OTHER_KEY), KEY, TID));
  });

  test("a payload edited in place fails the MAC", () => {
    const wire = sealHookToken(FIELDS, KEY);
    const [v, payloadB64, mac] = wire.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf8"));
    payload.wid = "ws_someoneelse";
    const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expectRejected(() => openHookToken(`${v}.${forged}.${mac}`, KEY, TID));
  });

  test("a validly-sealed token for another tenant is refused on tid", () => {
    // The MAC passes here — this is the residual case of one tenant's key
    // reaching another tenant's pod, which the tid check is what catches.
    const wire = sealHookToken({ ...FIELDS, tid: "tenant-b" }, KEY);
    expectRejected(() => openHookToken(wire, KEY, TID));
  });

  test.each([
    ["garbage", "not-a-token"],
    ["empty", ""],
    ["wrong version", "v2.abc.def"],
    ["two segments", "v1.abc"],
  ])("a malformed wire (%s) is refused", (_label, wire) => {
    expectRejected(() => openHookToken(wire, KEY, TID));
  });

  test("a payload with an unknown schema version is refused", () => {
    const bad = { ...FIELDS, v: 2 };
    const payloadB64 = Buffer.from(JSON.stringify(bad)).toString("base64url");
    // Re-MAC it correctly so only the version is wrong.
    const wire = sealHookToken(FIELDS, KEY);
    const forged = `v1.${payloadB64}.${wire.split(".")[2]}`;
    expectRejected(() => openHookToken(forged, KEY, TID));
  });
});

describe("hook token refuses to seal malformed fields", () => {
  test.each([
    ["tid", { tid: "Not A Tenant" }],
    ["wid", { wid: "not-a-workspace" }],
    ["connector", { connector: "Has Spaces" }],
    ["vendor", { vendor: "UPPER" }],
    ["kid", { kid: "" }],
  ])("%s", (_label, override) => {
    expectRejected(() => sealHookToken({ ...FIELDS, ...override }, KEY));
  });
});

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

describe("the rotation overlap window", () => {
  test("a URL minted under the outgoing key still opens while it is in the ring", () => {
    const wire = sealHookToken(FIELDS, OTHER_KEY);
    const opened = openHookTokenForIdentity(wire, {
      tid: TID,
      key: KEY,
      previousKeys: [OTHER_KEY],
    });
    expect(opened.payload.kid).toBe(FIELDS.kid);
    expect(opened.payload.wid).toBe(FIELDS.wid);
    // Slot 1 is the outgoing key — the signal that says the rotation is not done.
    expect(opened.slot).toBe(1);
  });

  test("dropping the outgoing key is what actually retires its URLs", () => {
    const wire = sealHookToken(FIELDS, OTHER_KEY);
    expectRejected(() => openHookTokenForIdentity(wire, { tid: TID, key: KEY }));
  });

  test("the ring seals under the first key, never an outgoing one", () => {
    const identity = readHookIdentity({
      [HOOK_TOKEN_KEY_ENV]: `${KEY.toString("base64")},${OTHER_KEY.toString("base64")}`,
      NB_TENANT_ID: TID,
    });
    expect(identity).toBeDefined();
    // What the ring seals under is the ring's first entry, and the outgoing key
    // opens without ever minting: a rotation that kept minting under the old key
    // would never finish, because the set of live old URLs would keep growing.
    const minted = sealHookToken(FIELDS, identity!.key);
    expect(() => openHookToken(minted, KEY, TID)).not.toThrow();
    expectRejected(() => openHookToken(minted, OTHER_KEY, TID));
    expect(identity!.previousKeys).toHaveLength(1);
  });

  test("a tenant that has never rotated carries no overlap", () => {
    const identity = readHookIdentity({
      [HOOK_TOKEN_KEY_ENV]: KEY.toString("base64"),
      NB_TENANT_ID: TID,
    });
    expect(identity?.previousKeys).toEqual([]);
  });

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

  test("another tenant's key in the ring still cannot open this tenant's door", () => {
    const wire = sealHookToken({ ...FIELDS, tid: "tenant-b" }, OTHER_KEY);
    expectRejected(() =>
      openHookTokenForIdentity(wire, { tid: TID, key: KEY, previousKeys: [OTHER_KEY] }),
    );
  });
});
