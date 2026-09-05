/**
 * The one reference shape config uses to point at a secret instead of carrying
 * one.
 *
 * **Config carries references; the store holds values.** A `nimblebrain.json`,
 * a `workspace.json`, or a `BundleRef` names the key it needs and nothing
 * about where the value lives — that stays the credential store's business
 * (`credential-store.ts`), which is what lets the backend swap from files to a
 * KMS without a config migration.
 *
 * A leaf module on purpose: the config types (`src/bundles/types.ts`,
 * `src/model/registry.ts`, the `connectors` block) and the store both import
 * this, so it may import nothing itself.
 *
 * The literal-string form stays valid everywhere a reference is accepted. A
 * reference is the option, not the requirement — a self-host operator with one
 * key in a file they already trust should not have to run a CLI to boot.
 */

/** A pointer into the credential store, resolved at the scope of whatever holds it. */
export interface CredentialRef {
  ref: "credential";
  key: string;
}

/**
 * Whether a config value is a credential reference rather than a literal.
 *
 * Structural, not nominal: config arrives from JSON, so there is no class to
 * check. `ref: "credential"` is the discriminant and a non-string `key` fails
 * here rather than at the filesystem, so a malformed reference reads as "not a
 * reference" and the caller's own type error names the field.
 */
export function isCredentialRef(value: unknown): value is CredentialRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ref?: unknown }).ref === "credential" &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

/** A config field that accepts either the secret itself or a reference to it. */
export type CredentialValue = string | CredentialRef;
