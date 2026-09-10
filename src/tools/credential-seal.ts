import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { isUniformByte } from "../oauth/envelope.ts";

/**
 * The codec that turns a secret into a line of ciphertext, and back.
 *
 * A leaf module: it holds the format and the key ring and nothing else. It
 * knows nothing about files, scopes-as-values, or which backend called it —
 * the sealing `file` backend wires it to `get`/`put`, and the boot sweep uses
 * the same two functions to re-wrap what is already on disk.
 *
 * **This is the first AEAD in the runtime and the first in-process key
 * derivation.** `src/oauth/envelope.ts` looks adjacent and is not: it is a
 * signed envelope (HMAC over a base64url payload), and the one `hkdfSync` in
 * `src/` is router-side. So this is a new security-critical construction to own
 * forever rather than a reuse of an existing one, and it is written to be read
 * that way — every choice below has its reason next to it.
 *
 * ## The wire format
 *
 * Five dot-separated ASCII fields, one line, **no trailing newline**:
 *
 * ```
 * NBS1.<kid>.<b64url(salt)>.<b64url(iv)>.<b64url(ciphertext||tag)>
 * ```
 *
 * | Field | Bytes | Why |
 * |---|---|---|
 * | `NBS1` | — | Magic + version. Bumping it is how a later backend migrates instead of flag-daying. |
 * | `kid` | 8, as 16 hex | Which ring entry sealed this, so rotation needs no bookkeeping. A **MAC**, never a digest of the key — see {@link kidFor}. |
 * | `salt` | 16, fresh per seal | Per-value, so the DEK is unique per value and GCM nonce reuse is structurally impossible. |
 * | `iv` | 12, fresh per seal | The AES-GCM nonce. |
 * | `ct‖tag` | n+16 | AES-256-GCM. |
 *
 * The magic is checked **unconditionally** by whoever reads a file, whether or
 * not a sealer is configured: a value matching this grammar that cannot be
 * opened must fail loudly, never be handed back as plaintext. That check is the
 * reader's, but the grammar is the format's, so it lives here as
 * {@link isSealedValue}.
 */

/**
 * Domain separator. Everything derived from a ring key carries it, so a key
 * that is ever reused for another purpose still derives different material
 * here. The `v1` is the format's, and moves with `NBS1`.
 */
const SEAL_INFO_PREFIX = "nimblebrain/credential-store/v1";

const MAGIC = "NBS1";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const DEK_BYTES = 32;
const KID_BYTES = 8;

/**
 * The grammar of a sealed value. A file matching this IS sealed, and a reader
 * that cannot open it must throw rather than return the bytes.
 *
 * `[\w-]` is the base64url alphabet (Node emits it unpadded), so a field that
 * picked up whitespace, a newline, or `+`/`/` from a standard-base64 encoder
 * fails the match rather than reaching the cipher.
 */
export const SEALED_VALUE_RE = /^NBS1\.[0-9a-f]{16}\.[\w-]+\.[\w-]+\.[\w-]+$/;

/** Does this look like a sealed value? Cheap, total, and never throws. */
export function isSealedValue(raw: string): boolean {
  return SEALED_VALUE_RE.test(raw);
}

/** Why an open failed. The backend turns this into an audit event and an error. */
export type CredentialSealFailure =
  | "malformed" // does not match the grammar at all
  | "unknown_kid" // sealed under a key this ring does not hold
  | "auth_failed"; // right key, wrong bytes — tampering, or a truncated write

export class CredentialSealError extends Error {
  constructor(
    readonly reason: CredentialSealFailure,
    message: string,
  ) {
    super(`[credential-seal] ${message}`);
    this.name = "CredentialSealError";
  }
}

/**
 * The key id for a ring entry: `HMAC-SHA256(ringKey, "<prefix>|kid")[0..8]`.
 *
 * **A MAC over a constant, not `sha256(ringKey)`.** A raw digest of key
 * material is published in every sealed file and in every error message that
 * names a wanted kid — it is not a practical break of a 32-byte CSPRNG key, but
 * it hands an offline attacker a free oracle against a weak or reused one, and
 * there is no reason to. Under the MAC the kid discloses nothing without the
 * key that produced it.
 */
function kidFor(ringKey: Buffer): string {
  return createHmac("sha256", ringKey)
    .update(`${SEAL_INFO_PREFIX}|kid`)
    .digest()
    .subarray(0, KID_BYTES)
    .toString("hex");
}

/**
 * The per-value info string: the domain separator, the owning scope, and the
 * key. It is both the HKDF `info` and the AEAD's additional authenticated data.
 *
 * **The AAD is defence in depth, not the mechanism.** The scope/key binding is
 * already carried by the derivation: a file copied from one scope to another,
 * or renamed to another key, derives a different DEK and fails on that alone —
 * the tag check never gets a chance to matter. Passing the same string as AAD
 * costs nothing and survives a future refactor that drops `info` from the
 * derivation, which is exactly the refactor that would silently unbind the two.
 */
function infoFor(scopeLabel: string, key: string): Buffer {
  return Buffer.from(`${SEAL_INFO_PREFIX}|${scopeLabel}|${key}`, "utf8");
}

/** Derive this value's data-encryption key. Caller zeroes it. */
function deriveDek(ringKey: Buffer, salt: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", ringKey, salt, info, DEK_BYTES));
}

/** The four fields of a sealed value, decoded. `undefined` if it is not one. */
export function parseSealedValue(
  raw: string,
): { kid: string; salt: Buffer; iv: Buffer; ciphertext: Buffer } | undefined {
  if (!isSealedValue(raw)) return undefined;
  const [, kid, salt, iv, ciphertext] = raw.split(".") as [string, string, string, string, string];
  const decoded = {
    kid,
    salt: Buffer.from(salt, "base64url"),
    iv: Buffer.from(iv, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
  };
  // The grammar admits any base64url length. Lengths the cipher cannot use are
  // a corrupt file, not a decode failure to discover three calls later.
  if (decoded.salt.length !== SALT_BYTES || decoded.iv.length !== IV_BYTES) return undefined;
  return decoded;
}

/**
 * A configured ring, ready to seal and open.
 *
 * `keys[0]` seals; every entry opens. That overlap IS the rotation seam:
 * prepend a new key, restart, and everything re-wraps under it while the
 * outgoing key still opens whatever the sweep has not reached. Drop the old
 * entry on the next rotation.
 */
export interface CredentialSealer {
  /** The kid `seal` stamps. What the boot sweep compares against. */
  readonly sealingKid: string;
  /** Every kid this ring can open, sealing key first. */
  readonly kids: readonly string[];
  seal(scopeLabel: string, key: string, value: string): string;
  open(scopeLabel: string, key: string, sealed: string): string;
}

/**
 * Build a sealer over a ring.
 *
 * `scopeLabel` is the caller's rendering of the owning scope — pass
 * `credentialScopeLabel(scope)`, never a hand-built string. It is bound into
 * the derivation, so two callers that disagree about it produce values neither
 * can open.
 */
export function createCredentialSealer(keys: readonly [Buffer, ...Buffer[]]): CredentialSealer {
  const kids = keys.map(kidFor);
  const sealingKey = keys[0];
  const sealingKid = kids[0] as string;

  return {
    sealingKid,
    kids,

    seal(scopeLabel: string, key: string, value: string): string {
      // Fresh per call, both of them. (key, IV) reuse under GCM leaks the
      // authentication subkey and the XOR of the plaintexts, so no code path —
      // the boot re-seal sweep included — may carry either of these forward
      // from a previous seal. A fresh salt alone would be enough, since it
      // makes the DEK unique; a fresh IV alone would be enough too. Both are
      // taken because the invariant then survives either one being refactored
      // away by someone who found it redundant.
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      const info = infoFor(scopeLabel, key);
      const dek = deriveDek(sealingKey, salt, info);
      try {
        const cipher = createCipheriv("aes-256-gcm", dek, iv);
        cipher.setAAD(info);
        const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        const sealed = Buffer.concat([body, cipher.getAuthTag()]);
        return [
          MAGIC,
          sealingKid,
          salt.toString("base64url"),
          iv.toString("base64url"),
          sealed.toString("base64url"),
        ].join(".");
      } finally {
        // Partial mitigation: the plaintext `string` cannot be zeroed in a GC'd
        // runtime, so this shortens the window on the derived key and nothing
        // more. It is free, and it is the half that can be done.
        dek.fill(0);
      }
    },

    open(scopeLabel: string, key: string, sealed: string): string {
      const parsed = parseSealedValue(sealed);
      if (!parsed) {
        throw new CredentialSealError(
          "malformed",
          `value at key "${key}" in scope ${scopeLabel} is not a sealed value`,
        );
      }
      const index = kids.indexOf(parsed.kid);
      if (index < 0) {
        // Naming both sides is safe and is the whole point of the kid: it is a
        // MAC over a constant, so it identifies a ring entry without disclosing
        // anything about the key behind it. An operator reading this line can
        // tell "the outgoing key was dropped too early" from "this file came
        // from somewhere else" without touching the ciphertext.
        throw new CredentialSealError(
          "unknown_kid",
          `value at key "${key}" in scope ${scopeLabel} is sealed under kid ${parsed.kid}, ` +
            `which this ring does not hold (ring: ${kids.join(", ")})`,
        );
      }
      const info = infoFor(scopeLabel, key);
      const dek = deriveDek(keys[index] as Buffer, parsed.salt, info);
      try {
        const tag = parsed.ciphertext.subarray(parsed.ciphertext.length - 16);
        const body = parsed.ciphertext.subarray(0, parsed.ciphertext.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", dek, parsed.iv);
        decipher.setAAD(info);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        // A tag failure is either tampering or the wrong key under a matching
        // kid, and the two are indistinguishable from here. Neither the value
        // nor the cipher's own message travels: the first is the secret and the
        // second is a padding-oracle surface for no operator benefit.
        throw new CredentialSealError(
          "auth_failed",
          `value at key "${key}" in scope ${scopeLabel} failed authentication under kid ${parsed.kid}; ` +
            "it was modified after sealing, or the key behind that kid is not the one that sealed it",
        );
      } finally {
        dek.fill(0);
      }
    },
  };
}

// ── The key ring ─────────────────────────────────────────────────────

const MIN_KEY_BYTES = 32;

/**
 * How many keys the ring may hold. A bound rather than a preference: every
 * entry is a key that still opens live secrets, so an unbounded ring is an
 * unbounded set of credentials nobody is tracking. Two is the rotation itself
 * (new + outgoing); the third is room for a rotation interrupted by another.
 */
const MAX_KEYS = 3;

/**
 * Read the ring from the environment variable the config names.
 *
 * One or more base64 keys of >= 32 bytes, comma-separated. **The first seals;
 * every one opens.**
 *
 * Absent is a legitimate state and returns `undefined`: a deployment with no
 * `secrets.config.seal` never asks, and one that does gets a boot failure from
 * its caller rather than a silent fall back to plaintext.
 *
 * **Losing every entry loses the secrets themselves**, not merely the ability
 * to mint something new. That is strictly worse than the hook-token key this
 * parse is ported from, and it is why the overlap window matters: the outgoing
 * key stays loaded until the next rotation, so a mistake is recoverable while
 * any old key is still in the ring.
 */
export function readCredentialKeyRing(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env,
): [Buffer, ...Buffer[]] | undefined {
  const raw = env[envVarName]?.trim();
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Separators and nothing else is a configured-but-empty ring. It clears the
  // absent check above, so without this it would seal under `keys[0]` of an
  // empty array — a configuration error reported as a crash at the first write
  // rather than at boot.
  if (entries.length === 0) {
    throw new Error(`[credential-seal] ${envVarName} holds only separators and names no key`);
  }
  if (entries.length > MAX_KEYS) {
    throw new Error(
      `[credential-seal] ${envVarName} holds ${entries.length} keys; at most ${MAX_KEYS} may be live at once`,
    );
  }
  const keys = entries.map((entry, index) => {
    const key = Buffer.from(entry, "base64");
    // Reject anything that does not survive a round trip. Node's base64 decoder
    // TRUNCATES at the first character outside the alphabet rather than
    // failing, and a 32-byte key always ends in `=` padding — so a ring written
    // with a newline, a space or a semicolon instead of a comma splits into ONE
    // entry that decodes to the first key alone, at full length, past every
    // check below. The ring would silently be no ring, and the outgoing key
    // would stop opening anything it had sealed. A separator slip in a
    // multi-line secret is exactly how that happens, so the parse has to catch
    // it rather than the format being trusted to prevent it.
    if (key.toString("base64") !== entry) {
      throw new Error(
        `[credential-seal] ${envVarName} entry ${index} is not valid base64 (separate keys with a comma)`,
      );
    }
    if (key.length < MIN_KEY_BYTES) {
      throw new Error(
        `[credential-seal] ${envVarName} entry ${index} must decode to >= ${MIN_KEY_BYTES} bytes (got ${key.length})`,
      );
    }
    // Same placeholder guard the OAuth master key gets. A configured-but-useless
    // key must fail at boot, not seal every secret under a value an attacker
    // can guess.
    if (isUniformByte(key, 0) || isUniformByte(key, 0xff)) {
      throw new Error(
        `[credential-seal] ${envVarName} entry ${index} is a placeholder pattern (all 0x00 or all 0xff); generate with a CSPRNG`,
      );
    }
    return key;
  });
  // The empty case threw above, so the ring has a first entry. Say so in the
  // type rather than at the call site: `keys[0]` IS the sealing key, and a
  // caller that has to assert that is a caller that could get it wrong.
  return keys as [Buffer, ...Buffer[]];
}
