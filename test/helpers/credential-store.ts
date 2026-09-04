import {
  _resetCredentialStoreForTest,
  type CredentialStore,
  FileCredentialStore,
  setCredentialStore,
} from "../../src/tools/credential-store.ts";
import type { EngineEvent } from "../../src/engine/types.ts";

/**
 * Install a process-wide credential store rooted at `workDir`, the way
 * `Runtime.start` does at the composition root.
 *
 * Anything that reads or writes a secret goes through the installed store and
 * throws without one — the OAuth provider included, since its tokens, PKCE
 * verifier, DCR registration and captured identity are all keys in it. A suite
 * that constructs one of those directly has no runtime to install the store, so
 * it installs one here instead of standing up a second, divergent backend.
 *
 * Pass `events` to capture `audit.credential_read` lines.
 */
export function installTestCredentialStore(
  workDir: string,
  events?: EngineEvent[],
): CredentialStore {
  const store = events
    ? new FileCredentialStore(workDir, {
        eventSink: {
          emit: (e) => {
            events.push(e);
          },
        },
      })
    : new FileCredentialStore(workDir);
  setCredentialStore(store);
  return store;
}

/** Drop the installed store so the next suite starts from none. */
export function resetTestCredentialStore(): void {
  _resetCredentialStoreForTest();
}
