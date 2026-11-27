import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Run grants (`contracts/host-context/CONTEXT.md` §6): the host's signed record
 * that a person, in a workspace, set up work under a contract that will run as
 * them with nobody present.
 *
 * A grant is `v1.<claims>.<signature>`: `claims` the base64url JSON
 * `{ "c": contract, "w": workspaceId, "o": ownerId }`, `signature` the base64url
 * HMAC-SHA256 of `v1.<claims>` under the installation's grant key. The format is
 * the host's; a plugin stores it verbatim and never reads it.
 *
 * One key signs and verifies. Replacing it (deleting the credential, so the next
 * boot mints another) makes every stored grant fail `grant_invalid` until a
 * grant-marked call re-stamps its definition, which is what the contracts say a
 * key change does. Membership is checked at every run, so a grant needs no
 * expiry.
 *
 * A leaf on purpose: the key is read from the credential store at the
 * composition root (`Runtime.start`), so this module imports nothing.
 */

/** The instance-scope credential-store key that holds the grant key, minted on first boot. */
export const RUN_GRANT_KEY_CREDENTIAL = "nimblebrain.run_grant_key";

const VERSION = "v1";

/** The claims a grant carries. */
export interface RunGrantClaims {
  contract: string;
  workspaceId: string;
  ownerId: string;
}

export interface RunGrants {
  /** A grant for the claims. */
  sign(claims: RunGrantClaims): string;
  /**
   * The owner a grant names, when its signature is this key's and it names
   * `contract` and `workspaceId`; null otherwise. Membership is the caller's
   * check.
   */
  verify(grant: string, contract: string, workspaceId: string): string | null;
}

/** A fresh grant key, as the credential store holds it (base64url, 32 bytes). */
export function newRunGrantKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Grants signed and verified under `key` (the credential's base64url value). */
export function createRunGrants(key: string): RunGrants {
  const secret = Buffer.from(key, "base64url");
  if (secret.length < 32) throw new Error(`${RUN_GRANT_KEY_CREDENTIAL} holds fewer than 32 bytes`);
  const mac = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  return {
    sign({ contract, workspaceId, ownerId }) {
      const claims = Buffer.from(
        JSON.stringify({ c: contract, w: workspaceId, o: ownerId }),
      ).toString("base64url");
      const payload = `${VERSION}.${claims}`;
      return `${payload}.${mac(payload).toString("base64url")}`;
    },
    verify(grant, contract, workspaceId) {
      const parts = grant.split(".");
      if (parts.length !== 3 || parts[0] !== VERSION) return null;
      const [, claims = "", signature = ""] = parts;
      const given = Buffer.from(signature, "base64url");
      const want = mac(`${VERSION}.${claims}`);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
      try {
        const { c, w, o } = JSON.parse(Buffer.from(claims, "base64url").toString("utf-8")) as {
          c?: unknown;
          w?: unknown;
          o?: unknown;
        };
        if (c !== contract || w !== workspaceId || typeof o !== "string" || !o) return null;
        return o;
      } catch {
        return null;
      }
    },
  };
}
