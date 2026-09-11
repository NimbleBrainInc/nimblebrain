import { DEFAULT_CREDENTIAL_STORE_BACKEND, type SecretsConfig } from "../config/secrets.ts";
import type { EventSink } from "../engine/types.ts";
import {
  type CredentialSealer,
  createCredentialSealer,
  readCredentialKeyRing,
} from "./credential-seal.ts";
import { type CredentialStore, FileCredentialStore } from "./credential-store.ts";

/**
 * What holds the secrets, and how that is chosen.
 *
 * ADR-0027 calls `CredentialStore` "the boundary between call sites and the
 * backend" and promises that "a managed deployment swaps in an encrypted
 * implementation … without touching a single caller." This registry is where
 * that swap happens — one named lookup at the composition root, and no call
 * site anywhere learns which backend answered.
 *
 * It is `credential-provider.ts` one layer down, on purpose. That registry's
 * contract is "the kernel never learns what a provider means … it just asks",
 * and the same holds here: `config` is OPAQUE to everything above the backend
 * that registered for the name. A vault backend's connection settings and the
 * file backend's sealing settings are both just `Record<string, unknown>` to
 * the runtime.
 *
 * **The rule that keeps this safe: config selects the backend and names where
 * key material lives; it never carries key material.** Configuration is
 * commonly rendered into a ConfigMap from a values file in version control, so
 * a key written into `secrets.config` is a key committed to a repository. The
 * schema refuses one (`nbNoInlineKeyMaterial` in
 * `nimblebrain-config.schema.json`) — the block names an environment variable,
 * and the runtime reads the key from there.
 */
export interface CredentialStoreBackend {
  create(ctx: {
    workDir: string;
    eventSink?: EventSink;
    /** This backend's own settings. Opaque above the backend. */
    config: Record<string, unknown>;
  }): CredentialStore;
}

const REGISTRY = new Map<string, CredentialStoreBackend>();

/** Register a named backend. Called at the composition root (and by tests).
 *  Re-registration overwrites — last writer wins. */
export function registerCredentialStoreBackend(
  name: string,
  backend: CredentialStoreBackend,
): void {
  REGISTRY.set(name, backend);
}

/** Look up a registered backend by name, or undefined if none is registered. */
export function getCredentialStoreBackend(name: string): CredentialStoreBackend | undefined {
  return REGISTRY.get(name);
}

/** Every registered name, sorted. What an unregistered-name error names. */
export function registeredCredentialStoreBackends(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * Test-only. Clear the registry so a suite can assert what a *composition root*
 * registered, rather than what a sibling test file happened to leave behind —
 * the registry is process-global and `bun test` shares one process, so without
 * this a "was it registered at boot?" assertion is satisfied by any earlier
 * registration and pins nothing.
 */
export function _resetCredentialStoreBackendsForTest(): void {
  REGISTRY.clear();
}

/**
 * The `seal` member of the file backend's config.
 *
 * `keyEnv` is the NAME of an environment variable, never a key. The schema
 * refuses an inline one (`nbNoInlineKeyMaterial`), because this block is
 * rendered from a file that is commonly in version control.
 */
interface SealConfig {
  keyEnv?: unknown;
}

/** Read and check `config.seal`, or `undefined` when the deployment wants none. */
function sealConfigFrom(config: Record<string, unknown>): { keyEnv: string } | undefined {
  const seal = config.seal;
  if (seal === undefined || seal === null) return undefined;
  if (typeof seal !== "object" || Array.isArray(seal)) {
    throw new Error('[credential-store] secrets.config.seal must be an object with a "keyEnv"');
  }
  const { keyEnv } = seal as SealConfig;
  if (typeof keyEnv !== "string" || keyEnv.length === 0) {
    throw new Error(
      '[credential-store] secrets.config.seal.keyEnv must name an environment variable, e.g. { "seal": { "keyEnv": "NB_CREDENTIAL_KEY" } }',
    );
  }
  return { keyEnv };
}

/**
 * A fixed value sealed and reopened before the store serves anything.
 *
 * **Its purpose is narrow, and worth stating precisely so nobody later mistakes
 * it for more.** The ring parse has already rejected every malformed, short,
 * placeholder and non-canonical ring by the time this runs, so what is left for
 * the canary is a runtime that cannot do AES-256-GCM or HKDF-SHA256 — a stripped
 * build, a FIPS-restricted OpenSSL, a platform change. Narrow, but the
 * alternative is discovering it at the first `put`, which for an instance key is
 * the first connector start and for a workspace key is a user in a settings page.
 *
 * **It cannot detect a key that is well-formed and simply the wrong 32 bytes.**
 * Seal-then-open under one key round-trips whatever that key is. Detecting a
 * wrong key needs something sealed under the *right* one to open, which nothing
 * at boot does today.
 *
 * Exported so its failure path has a test. A control whose failure path is never
 * exercised is a comment.
 */
export function runSealCanary(sealer: CredentialSealer, keyEnv: string): void {
  const label = "instance";
  const key = "nimblebrain.seal_canary";
  const value = "canary";
  let observed: string;
  try {
    observed = sealer.open(label, key, sealer.seal(label, key, value));
  } catch (err) {
    throw new Error(
      `[credential-store] the sealing key in ${keyEnv} does not round-trip: ${
        err instanceof Error ? err.message : String(err)
      }. Refusing to start rather than write secrets this runtime cannot read back.`,
    );
  }
  if (observed !== value) {
    throw new Error(
      `[credential-store] the sealing key in ${keyEnv} does not round-trip. ` +
        "Refusing to start rather than write secrets this runtime cannot read back.",
    );
  }
}

/**
 * The file backend: one file per secret under its scope's root, holding either
 * the secret verbatim or `NBS1.…` ciphertext.
 *
 * `config.seal` decides which, and its absence is the default — today's
 * behaviour, byte for byte. Present, it names the environment variable holding
 * the key ring, and a missing or empty variable is **fatal**: a deployment that
 * asked to be sealed and silently got plaintext files is the same silent
 * downgrade `createCredentialStore` refuses for an unknown backend name.
 */
export const fileCredentialStoreBackend: CredentialStoreBackend = {
  create({ workDir, eventSink, config }) {
    const seal = sealConfigFrom(config);
    if (!seal) {
      return new FileCredentialStore(workDir, eventSink ? { eventSink } : undefined);
    }
    const keys = readCredentialKeyRing(seal.keyEnv);
    if (!keys) {
      throw new Error(
        `[credential-store] secrets.config.seal names ${seal.keyEnv}, but it is unset or empty. ` +
          "Provision the key or remove the seal block — the runtime will not fall back to " +
          "plaintext files for a deployment that asked to be sealed.",
      );
    }
    const sealer = createCredentialSealer(keys);
    runSealCanary(sealer, seal.keyEnv);
    return new FileCredentialStore(workDir, { ...(eventSink ? { eventSink } : {}), sealer });
  },
};

/** Register every backend that ships in the box. Called at the composition root. */
export function registerBuiltinCredentialStoreBackends(): void {
  registerCredentialStoreBackend(DEFAULT_CREDENTIAL_STORE_BACKEND, fileCredentialStoreBackend);
}

/**
 * Build the process's credential store from the `secrets` block.
 *
 * An unregistered name **throws**. It does not fall back to `file`: a
 * deployment that asked for a vault and silently got plaintext files on disk is
 * the worst outcome available here, and a typo in a backend name is
 * indistinguishable from that at every later point.
 */
export function createCredentialStore(ctx: {
  workDir: string;
  eventSink?: EventSink;
  secrets?: SecretsConfig;
}): CredentialStore {
  const name = ctx.secrets?.backend ?? DEFAULT_CREDENTIAL_STORE_BACKEND;
  const backend = getCredentialStoreBackend(name);
  if (!backend) {
    const registered = registeredCredentialStoreBackends();
    throw new Error(
      `[credential-store] secrets.backend "${name}" is not a registered backend. ` +
        `Registered: ${registered.length > 0 ? registered.join(", ") : "(none)"}. ` +
        "Fix the name or register the backend at the composition root — the runtime " +
        "will not fall back to plaintext files for a backend it cannot find.",
    );
  }
  return backend.create({
    workDir: ctx.workDir,
    eventSink: ctx.eventSink,
    config: ctx.secrets?.config ?? {},
  });
}
