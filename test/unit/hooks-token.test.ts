import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { EnvelopeError } from "../../src/oauth/envelope.ts";
import {
  buildHookUrl,
  HOOK_TOKEN_KEY_ENV,
  newKid,
  openHookToken,
  readHookIdentity,
  readHookTokenKey,
  sealHookToken,
} from "../../src/hooks/token.ts";

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
    expect(readHookTokenKey({})).toBeUndefined();
    expect(readHookIdentity({})).toBeUndefined();
  });

  test("a key present but too short fails loudly at boot", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => readHookTokenKey({ [HOOK_TOKEN_KEY_ENV]: short })).toThrow(/32 bytes/);
  });

  test.each([
    ["all zeros", Buffer.alloc(32, 0)],
    ["all 0xff", Buffer.alloc(32, 0xff)],
  ])("a placeholder key (%s) fails loudly at boot", (_label, buf) => {
    expect(() => readHookTokenKey({ [HOOK_TOKEN_KEY_ENV]: buf.toString("base64") })).toThrow(
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

  test("the URL carries connector and vendor as path segments", () => {
    process.env.NB_PUBLIC_ORIGIN = "https://runtime.example";
    try {
      expect(buildHookUrl("acme-billing-mcp", "acme", "v1.a.b")).toBe(
        "https://runtime.example/v1/hooks/acme-billing-mcp/acme/v1.a.b",
      );
    } finally {
      delete process.env.NB_PUBLIC_ORIGIN;
    }
  });
});
