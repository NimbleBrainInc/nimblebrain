import { randomUUID } from "node:crypto";
import {
  ALLOWED_TID_PATTERN,
  EnvelopeError,
  isUniformByte,
  signMacEnvelope,
  verifyMacEnvelope,
} from "../oauth/envelope.ts";
import { publicOrigin } from "../oauth/public-origin.ts";
import { WORKSPACE_ID_RE } from "../workspace/workspace-id-pattern.ts";

/**
 * The hook token — a capability the runtime mints, hands to a server, and can
 * retire.
 *
 * It rides the SAME MAC envelope construction as the login assertion and the
 * tenant-key mint request (`signMacEnvelope` / `verifyMacEnvelope`), with its
 * own payload schema. One crypto construction, three schemas — not three
 * constructions.
 *
 * **It is MAC'd, not encrypted, and that is deliberate.** Confidentiality would
 * buy almost nothing here: the URL is
 * `https://<tenant-host>/v1/hooks/<connector>/<vendor>/<token>`, so the tenant,
 * the connector and the vendor are already in clear before the token begins.
 * Encryption's entire marginal gain is hiding `wid` and `kid`, and neither is a
 * credential — `wid` is an identifier (the workspace binding a delivery gets
 * comes from the identity headers the runtime mints AFTER verification, never
 * from this payload), and a `kid` admits nothing on its own, since admission
 * needs the MAC over the whole payload. Against that sits a second
 * security-critical codec to maintain forever. The honest cost of the trade,
 * and the reason it is written down in the platform's trust catalog rather than
 * left implicit: **a URL holder can read the payload**, so a leaked token also
 * discloses the workspace id and the wire format to whoever holds it.
 *
 * **It carries no expiry, also deliberately.** A vendor holds this URL for
 * months, and an `exp` could only ever fire late, silently, at a vendor nobody
 * is watching. Retirement is the `kid` lookup in
 * `HookRegistration` instead — checked on every single delivery, effective on
 * the next request after a write, and auditable. A revocation that runs every
 * time is strictly stronger than an expiry that runs once.
 */

/**
 * Env var holding this tenant's hook-token keys: one or more base64 keys of
 * >= 32 bytes, comma-separated. **The first seals; every one opens.**
 *
 * The order IS the rotation seam, and it exists because rotating this key is
 * otherwise destructive with no grace period anywhere. A vendor holds a hook
 * URL for months; the MAC is verified before any registration is looked up, so
 * the `kid` retirement grace that `rotateHook` gives a superseded registration
 * cannot help a key change. With a single key, loading a new one kills every
 * hook URL every vendor holds, across every workspace in the tenant, at once —
 * and the door answers 404 with nothing logged as wrong.
 *
 * With an overlap window the same rotation is ordinary: prepend the new key,
 * let re-registration mint fresh URLs under it while the old key still opens
 * the ones already out there, then drop the old key once nothing is minting
 * against it.
 *
 * Base64 has no comma, so the comma cannot be ambiguous — but that is not what
 * makes the parse safe. Node's decoder truncates at the first character outside
 * the alphabet instead of failing, so ANY other separator would yield one entry
 * holding the first key alone and pass every length check. Each entry is
 * round-tripped for that reason.
 */
export const HOOK_TOKEN_KEY_ENV = "NB_HOOK_TOKEN_KEY";

const MIN_HOOK_KEY_BYTES = 32;

/**
 * How many keys the ring may hold. A bound rather than a preference: every
 * entry is a key that still opens live URLs, so an unbounded ring is an
 * unbounded set of credentials nobody is tracking. Two is the rotation itself
 * (new + outgoing); the third is room for a rotation interrupted by another.
 */
const MAX_HOOK_KEYS = 3;

/**
 * Grammar for the `connector` and `vendor` path segments.
 *
 * Both are single URL path segments and both are sealed into the token and
 * cross-checked against the path, so the grammar has to be narrow enough that
 * "the segment the caller typed" and "the string we sealed" can never differ by
 * encoding. Lowercase alphanumeric with internal hyphens is what
 * `slugifyServerName` already produces for a connector; vendors are held to the
 * same shape so one rule covers both.
 */
export const HOOK_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Payload sealed into a hook token. */
export interface HookTokenPayload {
  /**
   * Payload schema version, distinct from the envelope's own `v1.` wire prefix.
   * The wire prefix versions the MAC construction shared by all three payload
   * schemas; this versions THIS schema alone. They are separable on purpose,
   * and it matters more here than anywhere else that rides the envelope: a
   * login assertion lives fifteen minutes, but a vendor holds a hook URL
   * indefinitely, so a future runtime has to be able to open tokens minted by
   * a much older one.
   */
  v: 1;
  tid: string;
  wid: string;
  connector: string;
  vendor: string;
  kid: string;
}

/** Mint a fresh key id. Opaque and unique is the whole requirement — ordering
 *  comes from the record's own `createdAt` / `rotatedAt`, so a sortable id
 *  would add a dependency to duplicate a field we already store. */
export function newKid(): string {
  return `hk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Read this tenant's hook key, or `undefined` when the deployment has none.
 *
 * Absent is a legitimate state, not an error: a local checkout and any
 * deployment that has not provisioned the key simply do not have a hooks door.
 * The caller's contract is to mount nothing in that case — an honest 404 at the
 * router — rather than mount a route that fails internally. Same posture as the
 * managed-connector provider routes in `app.ts`.
 *
 * Provisioned as a SIBLING of `NB_MCP_AUTHORIZER_TENANT_KEY`, never derived
 * from it, because the two have different lifecycles. The tenant key is cheap
 * to rotate — nothing outside the platform holds anything derived from it. This
 * key is expensive to rotate: third parties hold URLs minted under it, so
 * rotating it is a fleet-wide re-registration whose failure mode is deliveries
 * quietly stopping. Deriving one from the other would weld the cheap operation
 * to the expensive one, and the first routine tenant-key rotation after that
 * would take every registered webhook down with no error anywhere.
 */
export function readHookTokenKeys(
  env: NodeJS.ProcessEnv = process.env,
): [Buffer, ...Buffer[]] | undefined {
  const raw = env[HOOK_TOKEN_KEY_ENV]?.trim();
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // Separators and nothing else is a configured-but-empty ring. It clears the
  // absent check above, so without this it would mint under `keys[0]` of an
  // empty array — a configuration error reported as a crash at the first mint
  // rather than at boot.
  if (entries.length === 0) {
    throw new Error(`[hooks] ${HOOK_TOKEN_KEY_ENV} holds only separators and names no key`);
  }
  if (entries.length > MAX_HOOK_KEYS) {
    throw new Error(
      `[hooks] ${HOOK_TOKEN_KEY_ENV} holds ${entries.length} keys; at most ${MAX_HOOK_KEYS} may be live at once`,
    );
  }
  const keys = entries.map((entry, index) => {
    const key = Buffer.from(entry, "base64");
    // Reject anything that does not survive a round trip. Node's base64 decoder
    // TRUNCATES at the first character outside the alphabet rather than failing,
    // and a 32-byte key always ends in `=` padding — so a ring written with a
    // newline, a space or a semicolon instead of a comma splits into ONE entry
    // that decodes to the first key alone, at full length, past every check
    // below. The ring would silently be no ring, and every URL minted under the
    // outgoing key would 404 with nothing logged. A separator slip in a
    // multi-line secret is exactly how that happens, so the parse has to catch
    // it rather than the format being trusted to prevent it.
    if (key.toString("base64") !== entry) {
      throw new Error(
        `[hooks] ${HOOK_TOKEN_KEY_ENV} entry ${index} is not valid base64 (separate keys with a comma)`,
      );
    }
    if (key.length < MIN_HOOK_KEY_BYTES) {
      throw new Error(
        `[hooks] ${HOOK_TOKEN_KEY_ENV} entry ${index} must decode to >= ${MIN_HOOK_KEY_BYTES} bytes (got ${key.length})`,
      );
    }
    // Same placeholder guard the OAuth master key gets. A configured-but-useless
    // key must fail at boot, not mint forgeable capabilities that look fine.
    if (isUniformByte(key, 0) || isUniformByte(key, 0xff)) {
      throw new Error(
        `[hooks] ${HOOK_TOKEN_KEY_ENV} entry ${index} is a placeholder pattern (all 0x00 or all 0xff); generate with a CSPRNG`,
      );
    }
    return key;
  });
  // The empty case threw above, so the ring has a first entry. Say so in the
  // type rather than at the call site: `keys[0]` IS the sealing key, and a
  // caller that has to assert that is a caller that could get it wrong.
  return keys as [Buffer, ...Buffer[]];
}

/** Seal a hook token. Pure — no env, no I/O. */
export function sealHookToken(fields: Omit<HookTokenPayload, "v">, key: Buffer): string {
  if (!ALLOWED_TID_PATTERN.test(fields.tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  if (!WORKSPACE_ID_RE.test(fields.wid)) {
    throw new EnvelopeError("invalid_payload");
  }
  if (!HOOK_SLUG_RE.test(fields.connector) || !HOOK_SLUG_RE.test(fields.vendor)) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof fields.kid !== "string" || fields.kid.length === 0 || fields.kid.length > 64) {
    throw new EnvelopeError("invalid_payload");
  }
  const payload: HookTokenPayload = { v: 1, ...fields };
  return signMacEnvelope(payload, key);
}

/**
 * Open a hook token, or throw `EnvelopeError`.
 *
 * Every rejection reason — malformed wire, wrong key, wrong tenant, a field
 * that fails its grammar — is a throw, and the door collapses all of them into
 * one indistinguishable 404. Distinguishing them at the boundary would hand a
 * prober an oracle for which half of a guess was right.
 *
 * `expectedTid` is checked here rather than left to the caller because a token
 * sealed under another tenant's key cannot reach this point anyway (the MAC
 * fails first) — so this check is what catches the residual case of one
 * tenant's key being provisioned onto another tenant's pod, where the MAC
 * would pass and the routing would be wrong.
 */
export function openHookToken(wire: string, key: Buffer, expectedTid: string): HookTokenPayload {
  const raw = verifyMacEnvelope(wire, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new EnvelopeError("invalid_payload");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new EnvelopeError("invalid_payload");
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof p.tid !== "string" || !ALLOWED_TID_PATTERN.test(p.tid)) {
    throw new EnvelopeError("invalid_tid");
  }
  if (p.tid !== expectedTid) {
    throw new EnvelopeError("tid_mismatch");
  }
  if (typeof p.wid !== "string" || !WORKSPACE_ID_RE.test(p.wid)) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof p.connector !== "string" || !HOOK_SLUG_RE.test(p.connector)) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof p.vendor !== "string" || !HOOK_SLUG_RE.test(p.vendor)) {
    throw new EnvelopeError("invalid_payload");
  }
  if (typeof p.kid !== "string" || p.kid.length === 0 || p.kid.length > 64) {
    throw new EnvelopeError("invalid_payload");
  }
  return {
    v: 1,
    tid: p.tid,
    wid: p.wid,
    connector: p.connector,
    vendor: p.vendor,
    kid: p.kid,
  };
}

/** Path prefix the door is mounted at. Everything else beneath it 404s. */
export const HOOKS_PATH_PREFIX = "/v1/hooks";

/**
 * Build the URL handed to a server's `register_tool`.
 *
 * Origin comes from `publicOrigin()` — config-derived, never request-derived —
 * for the same reason every other outward-facing URL does: a host-header-derived
 * callback is an open redirect, and here it would additionally point a vendor's
 * deliveries at an attacker's origin for as long as the registration lasts.
 */
export function buildHookUrl(connector: string, vendor: string, token: string): string {
  return `${publicOrigin()}${HOOKS_PATH_PREFIX}/${connector}/${vendor}/${token}`;
}

/**
 * The tenant identity a hook token is minted and opened under: this tenant's id
 * and its hook key.
 *
 * Both halves are required and both come from deploy-provisioned env. `tid` is
 * sealed into every token and re-checked on every open, which is what makes one
 * tenant's key useless against another's door even if it were somehow
 * provisioned onto the wrong pod.
 */
export interface HookIdentity {
  tid: string;
  /** The key new tokens are sealed under — the ring's first entry. */
  key: Buffer;
  /**
   * Keys that still OPEN but no longer seal: the outgoing side of a rotation.
   * **Optional because absent is the steady state** — a deployment that has
   * never rotated has exactly one key, and modelling that as a required empty
   * array would make every construction site carry the rotation's vocabulary.
   * A URL minted under one of these stays live until the operator drops the
   * key, which is what makes rotating this key an ordinary operation rather
   * than a planned outage of the whole inbound path.
   */
  previousKeys?: readonly Buffer[];
}

/**
 * Resolve this runtime's hook identity, or `undefined` when the deployment has
 * no hooks door.
 *
 * Returning `undefined` rather than throwing is the whole posture: a local
 * checkout, an OSS run, and any tenant whose operator has not provisioned the
 * key all have no hooks door, and that is a legitimate configuration rather
 * than a misconfiguration. The caller mounts nothing, so `/v1/hooks/...` 404s
 * at the router — the honest "not installed" answer, and the same shape
 * `app.ts` already uses for managed-connector provider routes.
 *
 * A key that IS set but malformed still throws, from `readHookTokenKeys`. That
 * distinction matters: absent means "not configured", present-and-wrong means
 * "configured incorrectly", and only the second is a deploy that should fail.
 */
export function readHookIdentity(env: NodeJS.ProcessEnv = process.env): HookIdentity | undefined {
  const keys = readHookTokenKeys(env);
  if (!keys) return undefined;
  const tid = env.NB_TENANT_ID?.trim();
  if (!tid || !ALLOWED_TID_PATTERN.test(tid)) return undefined;
  return { tid, key: keys[0], previousKeys: keys.slice(1) };
}

/**
 * Open a hook token against the whole ring — the sealing key first, then each
 * key still in its overlap window.
 *
 * Order is for the common case, not for correctness: almost every delivery
 * opens on the first key, and a token that opens under none is the same 404 as
 * one that never verified. Which key opened it is deliberately not returned —
 * nothing downstream may branch on it, because a delivery's authority comes
 * from the registration lookup that follows, not from which key was current
 * when the URL was minted.
 */
export function openHookTokenForIdentity(
  wire: string,
  identity: HookIdentity,
): { payload: HookTokenPayload; slot: number } {
  const ring = [identity.key, ...(identity.previousKeys ?? [])];
  let firstError: unknown;
  for (let slot = 0; slot < ring.length; slot++) {
    try {
      // `slot` rides out for the delivery log ONLY. Nothing downstream may branch
      // on it: a delivery's authority comes from the registration lookup that
      // follows, not from which key happened to be current when the URL was
      // minted. What it buys is the ring's exit condition — without it an
      // operator cannot see whether any traffic still rides the outgoing key,
      // and dropping that key blind is the outage the ring exists to prevent.
      return { payload: openHookToken(wire, ring[slot] as Buffer, identity.tid), slot };
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError instanceof Error ? firstError : new EnvelopeError("invalid_payload");
}
