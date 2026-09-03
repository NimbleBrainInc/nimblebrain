import { randomBytes, randomUUID } from "node:crypto";
import { ALLOWED_TID_PATTERN, isUniformByte } from "../oauth/envelope.ts";
import { publicOrigin } from "../oauth/public-origin.ts";

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
export function buildHookUrl(deliveryId: string): string {
  return `${publicOrigin()}${HOOKS_PATH_PREFIX}/${deliveryId}`;
}

/**
 * Bytes of randomness behind a delivery id. 256 bits: the id IS the capability,
 * so it has to be unguessable on its own rather than merely unique.
 */
const DELIVERY_ID_BYTES = 32;

/**
 * Mint a delivery id — the secret a vendor holds and puts in the URL.
 *
 * **Why an opaque id rather than a sealed payload.** A self-describing token
 * carries tenant, workspace, connector, vendor and kid, and that costs length:
 * the URL it produced ran past 330 characters. At least one vendor stores a
 * webhook URL in a 255-character column and answers a 500 above it, so a URL
 * that long cannot be registered at all. Shortening the payload would have
 * fitted THAT vendor and left the margin depending on how long a tenant's
 * hostname happens to be — a correctness property nobody maintains, failing for
 * some tenants and not others. An opaque id is short by construction and the
 * margin does not move.
 *
 * What it costs is a lookup where a MAC verification used to be: the door can no
 * longer route from the URL alone. That sits behind the same pre-token rate
 * limiter the verification did, so it is not new exposure — it is a read instead
 * of a verification, in the same place.
 */
export function newDeliveryId(): string {
  return randomBytes(DELIVERY_ID_BYTES).toString("base64url");
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
  return { tid, key: keys[0] };
}
