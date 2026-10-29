import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";

/**
 * The installation's run key: the EdDSA (Ed25519) key the runtime signs a
 * turn's credentials with, and the public key set a callee verifies them
 * against (ADR-0057, "Credentials").
 *
 * A credential is a compact JWS (`alg: EdDSA`, `typ: JWT`, `kid`). It names a
 * turn and nothing it could widen: issuer, audience, subject, workspace, and
 * the issue and expiry times. Allowed tools, the unattended policy, spend
 * accounts and limits stay in the runtime, looked up by run id, so a copy in a
 * token can never drift from or exceed what the door decided.
 *
 * Signing uses `node:crypto` directly, as the OIDC provider's verification
 * does; the runtime takes no JOSE dependency for one algorithm.
 *
 * A leaf on purpose: the store read that supplies the ring happens at the
 * composition root (`Runtime.start`), so this module imports nothing of the
 * platform and the door can call it from anywhere in `src/runtime/`.
 */

/**
 * The instance-scope credential-store key that holds the run key ring.
 *
 * A fixed name rather than a config field: the run key belongs to the
 * installation, not to any block of `nimblebrain.json`, and reading it through
 * the store means a sealing backend holds it sealed like any other secret.
 * Set it with the `secrets set` CLI subcommand at instance scope.
 */
export const RUN_KEY_CREDENTIAL = "nimblebrain.run_key";

/**
 * The audience of every model credential. The installation's model gateway
 * requires it, so a credential minted for another callee (the tool projection)
 * is refused there, and one minted for the gateway is refused everywhere else.
 */
export const MODEL_GATEWAY_AUDIENCE = "model-gateway";

/**
 * The audience of every connection credential: what the runtime presents to an
 * external agent's worker on each request it sends it (ADR-0057, "A worker's
 * ACP endpoint is reachable only by its installation's runtime"). A worker
 * accepts this audience and no other, so a model credential cannot open a
 * connection and a connection credential cannot spend.
 */
export const CONNECTION_AUDIENCE = "acp-worker";

/** How long a connection credential lasts: the worker checks it on every request of a run. */
export const CONNECTION_CREDENTIAL_TTL_MS = 60 * 60_000;

/**
 * Clock skew allowed between the runtime and the gateway, added to a model
 * credential's lifetime so a turn that runs to the installation's longest
 * allowed duration is not refused by a gateway whose clock runs ahead.
 */
export const MODEL_CREDENTIAL_LEEWAY_MS = 60_000;

/**
 * Keys the ring may hold. Two is a rotation in progress (the new key signing,
 * the outgoing one still verifying until its last credential expires); the
 * third is room for a rotation interrupted by another. The same bound the
 * credential-store sealing ring holds, for the same reason: every entry is a
 * key someone must still be tracking.
 */
const MAX_RUN_KEYS = 3;

/** A public run key as the key set publishes it (RFC 8037). */
export interface RunPublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

/** The run key set: every key a credential this installation minted may name. */
export interface RunKeySet {
  keys: RunPublicJwk[];
}

/** One ring entry, parsed and checked. `private` never leaves this module. */
interface RunKeyEntry {
  kid: string;
  private: KeyObject;
  public: RunPublicJwk;
}

/** Why a ring was refused. The message names the entry, never its key material. */
export class RunKeyError extends Error {
  constructor(message: string) {
    super(`[run-key] ${message}`);
    this.name = "RunKeyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one private JWK into a ring entry.
 *
 * `x` is required and must match the public half derived from `d`: a ring
 * pasted together from two keys would otherwise publish a public key that
 * verifies nothing this runtime signs, and the failure would surface only at
 * the gateway.
 */
function parseEntry(raw: unknown, index: number): RunKeyEntry {
  if (!isRecord(raw)) throw new RunKeyError(`entry ${index} is not a JSON object`);
  const { kty, crv, kid, d, x } = raw;
  if (kty !== "OKP" || crv !== "Ed25519") {
    throw new RunKeyError(`entry ${index} must be an Ed25519 key (kty "OKP", crv "Ed25519")`);
  }
  if (typeof kid !== "string" || kid.length === 0) {
    throw new RunKeyError(`entry ${index} has no "kid"`);
  }
  if (typeof d !== "string" || typeof x !== "string") {
    throw new RunKeyError(`entry ${index} (kid ${kid}) must carry both "d" and "x"`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: { kty, crv, d, x }, format: "jwk" });
  } catch {
    // The library's own message can quote the input; this one names the entry.
    throw new RunKeyError(`entry ${index} (kid ${kid}) is not a valid Ed25519 private key`);
  }
  const derived = createPublicKey(privateKey).export({ format: "jwk" });
  if (derived.x !== x) {
    throw new RunKeyError(
      `entry ${index} (kid ${kid}): "x" is not the public half of "d"; the pair came from two keys`,
    );
  }
  return {
    kid,
    private: privateKey,
    public: { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" },
  };
}

/**
 * A parsed ring. The first key signs; every key is published, so a credential
 * signed by an outgoing key verifies until it expires.
 */
export interface RunKeyRing {
  readonly signingKid: string;
  readonly entries: readonly [RunKeyEntry, ...RunKeyEntry[]];
}

/**
 * Parse the ring from the stored value: a JWK Set (`{"keys": [...]}`) of
 * Ed25519 private keys, one to three of them, each with a distinct `kid`.
 * The first signs; the rest only verify.
 *
 * Throws {@link RunKeyError} on anything else. The caller reads the value at
 * boot, so a malformed ring stops the runtime rather than minting credentials
 * no gateway can verify.
 */
export function parseRunKeyRing(value: string): RunKeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RunKeyError(`${RUN_KEY_CREDENTIAL} is not JSON; it holds a JWK Set`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new RunKeyError(`${RUN_KEY_CREDENTIAL} must be a JWK Set: {"keys": [...]}`);
  }
  const raw = parsed.keys;
  if (raw.length === 0) throw new RunKeyError(`${RUN_KEY_CREDENTIAL} names no key`);
  if (raw.length > MAX_RUN_KEYS) {
    throw new RunKeyError(
      `${RUN_KEY_CREDENTIAL} holds ${raw.length} keys; at most ${MAX_RUN_KEYS} may be live at once`,
    );
  }
  const entries = raw.map(parseEntry);
  const kids = new Set<string>();
  for (const entry of entries) {
    if (kids.has(entry.kid)) {
      throw new RunKeyError(`${RUN_KEY_CREDENTIAL} names kid ${entry.kid} twice`);
    }
    kids.add(entry.kid);
  }
  const ring = entries as [RunKeyEntry, ...RunKeyEntry[]];
  return { signingKid: ring[0].kid, entries: ring };
}

/** What a model credential names: one run of the door, in one workspace. */
export interface ModelCredentialSubject {
  /** The door's run id. The gateway's budget lookups key on it. */
  runId: string;
  workspaceId: string;
  /**
   * The run's wall-clock limit. The credential expires at it plus the leeway,
   * held to the installation's ceiling. Absent = the ceiling.
   */
  maxRunDurationMs?: number;
}

/** The claims of a model credential. Nothing here bounds the run; the runtime does. */
export interface ModelCredentialClaims {
  iss: string;
  aud: typeof MODEL_GATEWAY_AUDIENCE;
  sub: string;
  workspace: string;
  iat: number;
  exp: number;
}

/** The claims of a pool credential: the pool, and no run. */
export interface PoolCredentialClaims {
  iss: string;
  aud: typeof MODEL_GATEWAY_AUDIENCE;
  sub: string;
  iat: number;
  exp: number;
}

/** The claims of a connection credential: the installation, and nothing about a run. */
export interface ConnectionCredentialClaims {
  iss: string;
  aud: typeof CONNECTION_AUDIENCE;
  sub: "runtime";
  iat: number;
  exp: number;
}

/** The installation's run key, ready to mint and publish. */
export interface RunKey {
  /** The key set served at {@link RUN_KEY_SET_PATH}. Public halves only. */
  keySet(): RunKeySet;
  /**
   * Mint the model credential for one run, when the run starts. It lasts the
   * run's own limit, held to the longest run the installation allows, plus
   * {@link MODEL_CREDENTIAL_LEEWAY_MS}.
   * Hold it in memory only: never write it to disk, a log, or a job store.
   */
  mintModelCredential(subject: ModelCredentialSubject, nowMs?: number): string;
  /**
   * Mint the credential a pooled worker of an agent that reads its provider
   * configuration per process is started with (`modelCredential: "process"`).
   * It names the pool, not a run, so the gateway attributes calls to the pool
   * alone. Its lifetime is the caller's, since it lasts as long as the worker it
   * is provisioned into, and it is rotated with the run key.
   */
  mintPoolCredential(pool: { poolId: string; ttlMs: number }, nowMs?: number): string;
  /**
   * Mint the credential the runtime presents to an external agent's worker on
   * every request of a connection. It names the installation and no run, so it
   * opens sessions and grants nothing a session's own credentials do not.
   */
  mintConnectionCredential(nowMs?: number): string;
}

/**
 * The public path of the run key set, on the runtime's own server.
 *
 * Not `/.well-known/jwks.json`, which OIDC tooling reads as the key set for
 * user tokens: a gateway or proxy that found this one there could accept run
 * credentials as sign-ins, or the reverse. The name says whose keys these are.
 */
export const RUN_KEY_SET_PATH = "/.well-known/run-keys.json";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJwt(entry: RunKeyEntry, claims: object): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: entry.kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), entry.private);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * Build the run key over a parsed ring.
 *
 * - `issuer` names the installation: the runtime's public origin, the one
 *   stable name an installation already has for itself, which a gateway pins.
 * - `maxRunMs` is the longest run the installation allows: the operator's
 *   wall-clock ceiling on a run (`tasks.maxRunDurationMs`, resolved). A model
 *   credential outlives it by the leeway and no more.
 */
export function createRunKey(opts: { ring: RunKeyRing; issuer: string; maxRunMs: number }): RunKey {
  const { ring, issuer, maxRunMs } = opts;
  const signing = ring.entries[0];
  const keys = ring.entries.map((entry) => entry.public);
  if (!Number.isFinite(maxRunMs) || maxRunMs <= 0) {
    throw new RunKeyError(`the longest run must be a positive duration (got ${maxRunMs})`);
  }

  return {
    keySet: () => ({ keys: keys.map((key) => ({ ...key })) }),

    mintModelCredential({ runId, workspaceId, maxRunDurationMs }, nowMs = Date.now()) {
      if (!runId) throw new RunKeyError("a model credential names a run id");
      if (!workspaceId) throw new RunKeyError("a model credential names a workspace");
      if (maxRunDurationMs !== undefined && !(maxRunDurationMs > 0)) {
        throw new RunKeyError(
          `a run's limit must be a positive duration (got ${maxRunDurationMs})`,
        );
      }
      const lifetimeMs = Math.min(maxRunDurationMs ?? maxRunMs, maxRunMs);
      const iat = Math.floor(nowMs / 1000);
      const claims: ModelCredentialClaims = {
        iss: issuer,
        aud: MODEL_GATEWAY_AUDIENCE,
        sub: runId,
        workspace: workspaceId,
        iat,
        exp: Math.ceil((nowMs + lifetimeMs + MODEL_CREDENTIAL_LEEWAY_MS) / 1000),
      };
      return signJwt(signing, claims);
    },

    mintConnectionCredential(nowMs = Date.now()) {
      const iat = Math.floor(nowMs / 1000);
      const claims: ConnectionCredentialClaims = {
        iss: issuer,
        aud: CONNECTION_AUDIENCE,
        sub: "runtime",
        iat,
        exp: Math.ceil((nowMs + CONNECTION_CREDENTIAL_TTL_MS) / 1000),
      };
      return signJwt(signing, claims);
    },
    mintPoolCredential({ poolId, ttlMs }, nowMs = Date.now()) {
      if (!poolId) throw new RunKeyError("a pool credential names a pool");
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RunKeyError(`a pool credential's lifetime must be positive (got ${ttlMs})`);
      }
      const claims: PoolCredentialClaims = {
        iss: issuer,
        aud: MODEL_GATEWAY_AUDIENCE,
        sub: poolId,
        iat: Math.floor(nowMs / 1000),
        exp: Math.ceil((nowMs + ttlMs) / 1000),
      };
      return signJwt(signing, claims);
    },
  };
}
