/**
 * The `secrets` block of `nimblebrain.json`: which backend holds this
 * deployment's secrets, and that backend's own settings.
 *
 * It lives in `src/config/` rather than beside the store because it is a
 * *config* shape — `RuntimeConfig` names it, and `src/runtime/` may not reach
 * into `src/tools/` (see `scripts/check-cycles.ts`). The registry that consumes
 * it is `src/tools/credential-store-backend.ts`.
 */

/**
 * Per deployment, and in a managed deployment per tenant — different tenants
 * legitimately want different answers (a trial on plaintext files, a regulated
 * one on sealed files, a later one pointed at a vault), and that selection
 * belongs in config rather than in a build flag or the presence of an
 * environment variable.
 */
export interface SecretsConfig {
  /** Registered backend name. Omitted means {@link DEFAULT_CREDENTIAL_STORE_BACKEND}. */
  backend?: string;
  /** Passed to that backend verbatim. Never key material — see below. */
  config?: Record<string, unknown>;
}

/** The backend a deployment gets when its config says nothing. */
export const DEFAULT_CREDENTIAL_STORE_BACKEND = "file";

// ── Schema drift guard ───────────────────────────────────────────────
//
// `Record<keyof Required<T>, true>` makes a field added to `SecretsConfig` a
// *compile* error until it is listed here, and
// `test/unit/config-schema-drift.test.ts` then fails until it is also declared
// in `nimblebrain-config.schema.json`. Two mechanical steps, no silent drift
// between the runtime's typed surface and the published schema.

const SECRETS_FIELDS: Record<keyof Required<SecretsConfig>, true> = {
  backend: true,
  config: true,
};

/** Every key the `secrets` block accepts. */
export const SECRETS_CONFIG_KEYS: string[] = Object.keys(SECRETS_FIELDS);

/**
 * The guard on `secrets.config`: config names where key material lives, and
 * never carries any.
 *
 * This is not a style rule. A `secrets` block is ordinary configuration — in a
 * managed deployment it is rendered into a ConfigMap from a values file in
 * version control, and a ConfigMap is not a Secret. So a key written here is a
 * key committed to a repository and readable by anything in the namespace. The
 * block names an environment variable instead, and the runtime reads the key
 * from there.
 *
 * Enforced rather than documented, because the mistake is one an operator makes
 * once and cannot un-make: the key is in git history from the moment it lands.
 */

/** Names that carry key material if they carry a value at all. */
const KEY_MATERIAL_NAME_RE = /key|secret|token|password/i;

/**
 * A property whose name ends in `Env` names an environment *variable* rather
 * than holding a value — `keyEnv: "NB_CREDENTIAL_KEY"` is the whole convention
 * this block is built on, and it matches {@link KEY_MATERIAL_NAME_RE}. So the
 * suffix is the carve-out, and it is a narrow one: the value must be a
 * plausible variable name, which is what stops the carve-out from becoming the
 * hole. A key pasted into `keyEnv` in base64 fails that grammar; one in hex
 * passes it and then fails at boot, loudly, when nothing in the environment
 * answers to that name.
 */
const ENV_NAME_SUFFIX_RE = /env$/i;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Below this, a string named `key`/`secret`/`token`/`password` is not key
 * material — it is a mode, a scheme name, or an enum. Above it, treat it as a
 * credential regardless of what it actually holds; the cost of a false positive
 * is renaming a field, and the cost of a false negative is a leaked key.
 */
const MAX_INCIDENTAL_LENGTH = 8;

/**
 * Is this one property a violation? Returns a reason, or `undefined`.
 *
 * **The reason never includes the value.** It is about to be logged and it is
 * the thing we are objecting to; quoting it back would copy the key into the
 * log line the rejection produces.
 */
function violationAt(name: string, value: unknown, path: string): string | undefined {
  if (ENV_NAME_SUFFIX_RE.test(name)) {
    if (typeof value === "string" && !ENV_VAR_NAME_RE.test(value)) {
      return `${path} must name an environment variable (letters, digits and underscores), not hold a value`;
    }
    return undefined;
  }
  if (
    KEY_MATERIAL_NAME_RE.test(name) &&
    typeof value === "string" &&
    value.length > MAX_INCIDENTAL_LENGTH
  ) {
    return `${path} looks like inline key material; name an environment variable instead (e.g. "${name}Env")`;
  }
  return undefined;
}

/**
 * Walk a config value for inline key material. Returns a reason naming the
 * offending path, or `undefined` when clean.
 *
 * The walk descends through every property, `Env`-suffixed ones included — a
 * `*Env` name is a carve-out for the value it holds, not for a subtree beneath
 * it, and `{ tokenEnv: { key: "…" } }` is still a key in a config file.
 *
 * `owner` is the property an array sits under. Elements have no names of their
 * own, so each is judged by that one: `keys: ["…"]` is the claim `key: "…"`
 * makes, once per element.
 */
export function findInlineKeyMaterial(
  value: unknown,
  path = "secrets.config",
  owner?: string,
): string | undefined {
  if (Array.isArray(value)) return findInElements(value, path, owner);
  if (value === null || typeof value !== "object") return undefined;

  for (const [name, child] of Object.entries(value)) {
    const here = `${path}.${name}`;
    const violation = violationAt(name, child, here);
    if (violation) return violation;
    const found = findInlineKeyMaterial(child, here, name);
    if (found) return found;
  }
  return undefined;
}

/** The array half of the walk. Every element is judged by `owner`. */
function findInElements(items: unknown[], path: string, owner?: string): string | undefined {
  for (const [index, item] of items.entries()) {
    const here = `${path}[${index}]`;
    const violation = owner === undefined ? undefined : violationAt(owner, item, here);
    if (violation) return violation;
    const found = findInlineKeyMaterial(item, here, owner);
    if (found) return found;
  }
  return undefined;
}
