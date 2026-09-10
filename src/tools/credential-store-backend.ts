import { DEFAULT_CREDENTIAL_STORE_BACKEND, type SecretsConfig } from "../config/secrets.ts";
import type { EventSink } from "../engine/types.ts";
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
 * The file backend: one file per secret under its scope's root.
 *
 * Ignores `config` today. The sealing settings that will select ciphertext go
 * here, which is why the parameter exists before anything reads it.
 */
export const fileCredentialStoreBackend: CredentialStoreBackend = {
  create({ workDir, eventSink }) {
    return new FileCredentialStore(workDir, eventSink ? { eventSink } : undefined);
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
