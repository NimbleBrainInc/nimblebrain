/**
 * The sealing codec. This is the runtime's first AEAD and its first in-process
 * key derivation, so the suite is written against the *format* and the
 * invariants rather than against the implementation — a rewrite that keeps the
 * wire compatible should keep every test here green.
 */

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  createCredentialSealer,
  CredentialSealError,
  isSealedValue,
  parseSealedValue,
  readCredentialKeyRing,
} from "../../src/tools/credential-seal.ts";

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const KEY_C = Buffer.alloc(32, 0x33);

const WS = "workspace:ws_test";
const INSTANCE = "instance";

function sealerFor(...keys: Buffer[]) {
  return createCredentialSealer(keys as [Buffer, ...Buffer[]]);
}

describe("the wire format", () => {
  test("a sealed value round-trips", () => {
    const s = sealerFor(KEY_A);
    const sealed = s.seal(WS, "acme.db_url", "supersecret");
    expect(s.open(WS, "acme.db_url", sealed)).toBe("supersecret");
  });

  test("it is one line of five dot-separated fields, with no trailing newline", () => {
    const sealed = sealerFor(KEY_A).seal(WS, "k", "v");
    expect(sealed.split(".")).toHaveLength(5);
    expect(parseSealedValue(sealed)).toBeDefined();
    expect(sealed).not.toContain("\n");
    expect(sealed.endsWith("\n")).toBe(false);
    expect(sealed.startsWith("NBS1.")).toBe(true);
  });

  test("a value that genuinely ends in a newline survives byte-exact", () => {
    // The plaintext file path trims one trailing newline as an `echo > file`
    // affordance, which silently corrupts a value that really ends in one.
    // Sealed bytes are exact, so this is the half that is not lossy.
    const s = sealerFor(KEY_A);
    for (const value of ["value\n", "\n", "a\nb\n\n", "  padded  ", ""]) {
      expect(s.open(WS, "k", s.seal(WS, "k", value))).toBe(value);
    }
  });

  test("non-ASCII and long values survive", () => {
    const s = sealerFor(KEY_A);
    const value = `${"ünïcodé — 🔐 ".repeat(200)}end`;
    expect(s.open(WS, "k", s.seal(WS, "k", value))).toBe(value);
  });

  test("isSealedValue gates on the magic, so damage stays sealed rather than becoming plaintext", () => {
    const sealed = sealerFor(KEY_A).seal(WS, "k", "v");
    expect(isSealedValue(sealed)).toBe(true);

    // The point of the weaker gate. Each of these is a sealed value that lost
    // its well-formedness — an operator writing it back with `echo`, a
    // truncated write, a cut field. Under a full-grammar gate every one reads
    // as legacy plaintext and is handed out AS the credential; under this one
    // they all still claim to be sealed, so `open` refuses them.
    for (const damaged of [
      `${sealed}\n`,
      ` ${sealed}`.trimStart() + " ",
      sealed.slice(0, -4),
      sealed.split(".").slice(0, 4).join("."),
      "NBS1.",
      "NBS1.short.a.b.c",
      "NBS1.0011223344556677.a+b.c/d.e=",
    ]) {
      expect(isSealedValue(damaged)).toBe(true);
      expect(() => sealerFor(KEY_A).open(WS, "k", damaged)).toThrow(CredentialSealError);
    }

    // Anything not claiming to be sealed is plaintext, including a near miss on
    // the magic itself.
    for (const plain of ["sk-live-abcdefghijklmnop", "", "NBS1", "NBS0.0011223344556677.a.b.c"]) {
      expect(isSealedValue(plain)).toBe(false);
    }
  });

  test("parseSealedValue rejects field lengths the cipher cannot use", () => {
    const sealed = sealerFor(KEY_A).seal(WS, "k", "v");
    const [magic, kid, salt, iv, ct] = sealed.split(".");
    expect(parseSealedValue(sealed)).toBeDefined();
    // A short salt or IV matches the grammar and is still a corrupt file.
    expect(parseSealedValue([magic, kid, "AAAA", iv, ct].join("."))).toBeUndefined();
    expect(parseSealedValue([magic, kid, salt, "AAAA", ct].join("."))).toBeUndefined();
  });
});

describe("tampering", () => {
  // Every field, one at a time. A format where only some fields are covered is
  // a format with a field an attacker can move.
  const FIELDS = ["magic", "kid", "salt", "iv", "ciphertext"] as const;

  // Flip a bit of the DECODED field and re-encode. Editing the last character
  // of the encoding is not a mutation: base64url's final character carries two
  // or four data bits, so several characters decode to the same bytes and the
  // "tampered" value opens cleanly — a test that passes on the throw of the
  // dice rather than on the property.
  for (const [index, field] of FIELDS.entries()) {
    test(`flipping a bit of the ${field} makes open fail`, () => {
      const s = sealerFor(KEY_A);
      const parts = s.seal(WS, "k", "supersecret").split(".");
      if (field === "magic") {
        parts[index] = "NBS1x";
      } else {
        const bytes = Buffer.from(parts[index] as string, field === "kid" ? "hex" : "base64url");
        bytes[0] = (bytes[0] as number) ^ 1;
        parts[index] = bytes.toString(field === "kid" ? "hex" : "base64url");
      }
      expect(() => s.open(WS, "k", parts.join("."))).toThrow(CredentialSealError);
    });
  }

  test("every field's mutation is a real one", () => {
    // The guard on the guard: a mutation that decoded back to the original
    // would make each case above vacuous, which is exactly how the first
    // version of this block passed.
    const parts = sealerFor(KEY_A).seal(WS, "k", "supersecret").split(".");
    for (const index of [1, 2, 3, 4]) {
      const enc = index === 1 ? "hex" : "base64url";
      const bytes = Buffer.from(parts[index] as string, enc);
      bytes[0] = (bytes[0] as number) ^ 1;
      expect(bytes.toString(enc)).not.toBe(parts[index]);
    }
  });

  test("a non-canonical encoding of the same bytes is refused", () => {
    // base64url is not injective: the trailing character of a 16-byte salt
    // carries two data bits, so four characters decode identically. Admitting
    // those would give every sealed value a family of variants that all open.
    const s = sealerFor(KEY_A);
    const parts = s.seal(WS, "k", "v").split(".");
    const salt = parts[2] as string;
    const last = salt.at(-1) as string;
    const alt = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      .split("")
      .find(
        (c) =>
          c !== last &&
          Buffer.from(salt.slice(0, -1) + c, "base64url").equals(
            Buffer.from(salt, "base64url"),
          ),
      );
    expect(alt).toBeDefined();
    parts[2] = salt.slice(0, -1) + alt;
    expect(() => s.open(WS, "k", parts.join("."))).toThrow(CredentialSealError);
  });

  test("a ciphertext field too short to hold a tag is refused", () => {
    // Node verifies GCM against however many tag bytes it is handed unless the
    // length is pinned, so a truncated field is a weaker forgery target rather
    // than a rejection. Refused twice over: by the parse, and by authTagLength.
    const s = sealerFor(KEY_A);
    const parts = s.seal(WS, "k", "").split(".");
    const full = Buffer.from(parts[4] as string, "base64url");
    for (const n of [0, 4, 8, 15]) {
      parts[4] = full.subarray(0, n).toString("base64url");
      expect(() => s.open(WS, "k", parts.join("."))).toThrow(CredentialSealError);
    }
  });

  test("a kid changed to another valid hex value is an unknown kid, not a fallback", () => {
    // Within the kid's own alphabet, so the grammar passes and the failure is
    // the ring lookup's. Nothing here may quietly try the other entries.
    const s = sealerFor(KEY_A);
    const parts = s.seal(WS, "k", "supersecret").split(".");
    parts[1] = `${(parts[1] as string).slice(0, -1)}${parts[1]?.endsWith("0") ? "1" : "0"}`;
    try {
      s.open(WS, "k", parts.join("."));
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as CredentialSealError).reason).toBe("unknown_kid");
    }
  });

  test("truncating the tag makes open fail", () => {
    const s = sealerFor(KEY_A);
    const parts = s.seal(WS, "k", "supersecret").split(".");
    const ct = Buffer.from(parts[4] as string, "base64url");
    parts[4] = ct.subarray(0, ct.length - 4).toString("base64url");
    expect(() => s.open(WS, "k", parts.join("."))).toThrow(CredentialSealError);
  });

  test("a failed open names the reason and never the value", () => {
    const s = sealerFor(KEY_A);
    const parts = s.seal(WS, "k", "supersecret").split(".");
    // Decoded-byte flip, for the same reason the block above uses one: editing
    // the final character of a base64url field is a no-op whenever that
    // character already encodes the value it would be swapped for.
    const ct = Buffer.from(parts[4] as string, "base64url");
    ct[0] = (ct[0] as number) ^ 1;
    parts[4] = ct.toString("base64url");
    try {
      s.open(WS, "k", parts.join("."));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialSealError);
      expect((err as CredentialSealError).reason).toBe("auth_failed");
      expect((err as CredentialSealError).message).not.toContain("supersecret");
    }
  });

  test("plaintext handed to open is refused as malformed, never returned", () => {
    const s = sealerFor(KEY_A);
    try {
      s.open(WS, "k", "sk-live-abcdefghijklmnop");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as CredentialSealError).reason).toBe("malformed");
    }
  });
});

describe("the scope and key are bound into the value", () => {
  // A file copied between scopes, or renamed to another key, derives a
  // different DEK and fails on that alone — the tag check never gets a chance
  // to matter. The AAD carries the same string as defence in depth.
  test("a value sealed at one scope does not open at another", () => {
    const s = sealerFor(KEY_A);
    const sealed = s.seal(WS, "acme.db_url", "workspace-value");
    expect(() => s.open(INSTANCE, "acme.db_url", sealed)).toThrow(CredentialSealError);
    expect(() => s.open("workspace:ws_other", "acme.db_url", sealed)).toThrow(CredentialSealError);
    expect(() => s.open("user:usr_alex01", "acme.db_url", sealed)).toThrow(CredentialSealError);
  });

  test("a value renamed to another key does not open", () => {
    const s = sealerFor(KEY_A);
    const sealed = s.seal(WS, "acme.db_url", "v");
    expect(() => s.open(WS, "other.key", sealed)).toThrow(CredentialSealError);
  });

  test("the binding failure is authentication, not a parse error", () => {
    // It must reach the cipher and fail there. A scope mismatch that surfaced
    // as `malformed` would be indistinguishable from a corrupt file.
    const s = sealerFor(KEY_A);
    const sealed = s.seal(WS, "k", "v");
    try {
      s.open(INSTANCE, "k", sealed);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as CredentialSealError).reason).toBe("auth_failed");
    }
  });
});

describe("every seal gets a fresh salt and a fresh IV", () => {
  // (key, IV) reuse under GCM leaks the authentication subkey and the XOR of
  // the plaintexts. This is the regression that pins the invariant against a
  // future path — the boot re-seal sweep included — that carries either field
  // forward from a previous seal because it looks like a saving.
  test("sealing the same value twice differs in salt AND in iv", () => {
    const s = sealerFor(KEY_A);
    const a = s.seal(WS, "k", "identical").split(".");
    const b = s.seal(WS, "k", "identical").split(".");
    expect(a[2]).not.toBe(b[2]); // salt
    expect(a[3]).not.toBe(b[3]); // iv
    expect(a[4]).not.toBe(b[4]); // and therefore the ciphertext
    expect(a[1]).toBe(b[1]); // same ring entry, same kid
  });

  test("neither field repeats across many seals of one value", () => {
    const s = sealerFor(KEY_A);
    const salts = new Set<string>();
    const ivs = new Set<string>();
    for (let i = 0; i < 256; i++) {
      const parts = s.seal(WS, "k", "identical").split(".");
      salts.add(parts[2] as string);
      ivs.add(parts[3] as string);
    }
    expect(salts.size).toBe(256);
    expect(ivs.size).toBe(256);
  });

  test("the ciphertext is not a function of the plaintext alone", () => {
    // Deterministic output would leak equality between two secrets that happen
    // to match — across scopes, across tenants, and to anyone holding the disk.
    const s = sealerFor(KEY_A);
    expect(s.seal(WS, "k", "v")).not.toBe(s.seal(WS, "k", "v"));
  });
});

describe("the kid is a MAC, never a digest of key material", () => {
  test("a kid is 16 hex characters", () => {
    expect(sealerFor(KEY_A).sealingKid).toMatch(/^[0-9a-f]{16}$/);
  });

  test("it is not the truncated SHA-256 of the key", () => {
    // A raw digest of key material rides in every sealed file and in every error naming a wanted kid; under the MAC the kid
    // discloses nothing without the key that produced it.
    const rawDigest = createHash("sha256").update(KEY_A).digest("hex").slice(0, 16);
    expect(sealerFor(KEY_A).sealingKid).not.toBe(rawDigest);
  });

  test("different keys get different kids, and one key is stable", () => {
    expect(sealerFor(KEY_A).sealingKid).not.toBe(sealerFor(KEY_B).sealingKid);
    expect(sealerFor(KEY_A).sealingKid).toBe(sealerFor(KEY_A).sealingKid);
  });
});

describe("the ring — the first seals, every one opens", () => {
  test("keys[0] seals and its kid is stamped", () => {
    const s = sealerFor(KEY_B, KEY_A);
    expect(s.sealingKid).toBe(sealerFor(KEY_B).sealingKid);
    expect(s.seal(WS, "k", "v").split(".")[1]).toBe(s.sealingKid);
  });

  test("a later entry opens what the first cannot", () => {
    // The rotation seam: a value sealed under the outgoing key still opens
    // after the new key is prepended.
    const old = sealerFor(KEY_A);
    const sealed = old.seal(WS, "k", "from-the-outgoing-key");
    const rotated = sealerFor(KEY_B, KEY_A);
    expect(rotated.open(WS, "k", sealed)).toBe("from-the-outgoing-key");
  });

  test("a ring of one still opens its own", () => {
    const s = sealerFor(KEY_A);
    expect(s.open(WS, "k", s.seal(WS, "k", "v"))).toBe("v");
  });

  test("dropping the sealing key strands what it sealed, loudly", () => {
    const sealed = sealerFor(KEY_A).seal(WS, "k", "v");
    try {
      sealerFor(KEY_B).open(WS, "k", sealed);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as CredentialSealError).reason).toBe("unknown_kid");
      // Both sides are named: a kid is a MAC over a constant, so it identifies
      // a ring entry without disclosing the key behind it, and an operator can
      // tell "the outgoing key was dropped too early" from "this file came from
      // somewhere else" without touching the ciphertext.
      expect((err as CredentialSealError).message).toContain(
        sealerFor(KEY_A).sealingKid,
      );
      expect((err as CredentialSealError).message).toContain(sealerFor(KEY_B).sealingKid);
    }
  });

  test("`kids` lists every entry, sealing key first", () => {
    const s = sealerFor(KEY_B, KEY_A, KEY_C);
    expect(s.kids).toEqual([
      sealerFor(KEY_B).sealingKid,
      sealerFor(KEY_A).sealingKid,
      sealerFor(KEY_C).sealingKid,
    ]);
  });
});

describe("reading the ring from the environment", () => {
  const b64 = (b: Buffer) => b.toString("base64");
  const ENV = "NB_CREDENTIAL_KEY";

  function read(value: string | undefined) {
    return readCredentialKeyRing(ENV, value === undefined ? {} : { [ENV]: value });
  }

  test("absent is a legitimate state, not an error", () => {
    expect(read(undefined)).toBeUndefined();
    expect(read("")).toBeUndefined();
    expect(read("   ")).toBeUndefined();
  });

  test("one key, and three, parse", () => {
    expect(read(b64(KEY_A))).toHaveLength(1);
    expect(read([KEY_A, KEY_B, KEY_C].map(b64).join(","))).toHaveLength(3);
  });

  test("surrounding whitespace on an entry is tolerated", () => {
    // A multi-line secret in a manifest picks these up; the key is still the key.
    expect(read(` ${b64(KEY_A)} , ${b64(KEY_B)} `)).toHaveLength(2);
  });

  test("separators and nothing else is a configured-but-empty ring, and throws", () => {
    // It clears the absent check, so without this it would seal under `keys[0]`
    // of an empty array — a config error surfacing as a crash at the first
    // write rather than at boot.
    expect(() => read(",,,")).toThrow(/names no key/);
  });

  test("more than three keys is refused", () => {
    const four = [KEY_A, KEY_B, KEY_C, randomBytes(32)].map(b64).join(",");
    expect(() => read(four)).toThrow(/at most 3/);
  });

  // The trap this parse exists for, ported from the hook-token ring.
  test("a separator that is not a comma is caught, not silently truncated", () => {
    // Node's base64 decoder TRUNCATES at the first character outside the
    // alphabet instead of failing. Without the round-trip check each of these
    // decodes to the first key alone, at full length, past every other check —
    // and the ring is silently no ring.
    for (const separator of ["\n", " ", ";", "|", ":"]) {
      const raw = [b64(KEY_A), b64(KEY_B)].join(separator);
      expect(() => read(raw)).toThrow(/not valid base64/);
    }
  });

  test("the truncation is real, which is why the check is", () => {
    // Pins the platform behaviour the check defends against, so a future Node
    // or Bun that starts throwing here does not leave the guard looking
    // superstitious.
    expect(Buffer.from("AAAA,BBBB", "base64")).toHaveLength(6);
  });

  test("a key under 32 bytes is refused", () => {
    expect(() => read(b64(Buffer.alloc(31, 0x11)))).toThrow(/>= 32 bytes/);
  });

  test("placeholder patterns are refused", () => {
    expect(() => read(b64(Buffer.alloc(32, 0x00)))).toThrow(/placeholder pattern/);
    expect(() => read(b64(Buffer.alloc(32, 0xff)))).toThrow(/placeholder pattern/);
  });

  test("the offending entry is named by index", () => {
    expect(() => read([b64(KEY_A), b64(Buffer.alloc(32, 0))].join(","))).toThrow(/entry 1/);
  });

  test("no error message carries key material", () => {
    const short = b64(Buffer.alloc(31, 0x11));
    try {
      read(short);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(short);
    }
  });

  test("a ring read from the environment seals and opens", () => {
    const keys = read([b64(KEY_A), b64(KEY_B)].join(","));
    expect(keys).toBeDefined();
    const s = createCredentialSealer(keys as [Buffer, ...Buffer[]]);
    expect(s.open(WS, "k", s.seal(WS, "k", "v"))).toBe("v");
  });
});
