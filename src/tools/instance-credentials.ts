/**
 * Dereference the credential references an operator's own config carries.
 *
 * Instance config — `nimblebrain.json` and `instance.json` — holds the keys the
 * deployment itself owns: LLM provider keys, the broker and gateway credentials,
 * the IdP key. Each of those fields accepts the secret inline or
 * `{ ref: "credential", key }`, resolved from the **instance** scope of the
 * credential store. The env fallbacks each field already had are untouched and
 * remain the last tier: declared reference, else declared literal, else env.
 *
 * ## Why this is a structural walk and not a list of fields
 *
 * Naming the fields that may carry a reference would be a second copy of the
 * config schema, and it would go stale the next time a provider gains a key —
 * silently, because an unresolved reference reads as an object where a string
 * was expected and lands in a vendor SDK as `[object Object]`. So the rule is
 * general instead: **anywhere in instance config that a string is expected, a
 * credential reference may stand in its place.** A new provider's key works
 * with no change here.
 *
 * The published JSON schema advertises the reference shape only on the fields it
 * is documented for. That asymmetry is deliberate — the schema is the surface we
 * support, this is the mechanism, and a mechanism narrower than its surface is
 * the failure mode above.
 *
 * ## Why it resolves at boot rather than at each read
 *
 * The readers are synchronous and cached by construction — `buildRegistry`
 * instantiates provider SDKs eagerly, `validateComposioConfig` memoizes on first
 * call — so a per-read async dereference would mean rewriting each of them
 * around a store. Resolving once, at the composition root, leaves every reader
 * untouched. The cost is honest and stated in the docs: rotating an
 * instance-scope secret takes a restart. Instance scope is CLI-or-config only
 * and changes at deploy cadence; workspace scope, which tenants rotate, resolves
 * per connection instead.
 */

import { isCredentialRef } from "./credential-ref.ts";
import { type CredentialScope, resolveCredentialValue } from "./credential-store.ts";

const INSTANCE_SCOPE: CredentialScope = { kind: "instance" };

/**
 * A JSON object literal — not a class instance.
 *
 * The walk descends only into these (and arrays). `RuntimeConfig` carries live
 * objects alongside its JSON — `events: EventSink[]`, `confirmationGate`, a
 * custom `model.adapter` — and descending into one would rebuild it as a plain
 * object and strip its prototype. Nothing secret hides behind a class here, so
 * refusing to enter one costs nothing.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Replace every credential reference under `value` with its instance-scope
 * secret, returning `value` itself when nothing changed.
 *
 * Identity-preserving on purpose: a config with no references comes back as the
 * same object, and one with a reference deep in `connectors.gateways.acme` is
 * copied only along that path. So this never becomes a hidden deep clone of the
 * caller's config, and a live object elsewhere in the tree keeps its identity.
 *
 * `path` is the dotted config path, and it is what the audit line calls the
 * read's purpose — `connectors.providers.composio.apiKey`, not "config".
 */
async function derefArray(value: unknown[], path: string): Promise<unknown> {
  const out: unknown[] = [];
  let changed = false;
  for (let i = 0; i < value.length; i++) {
    const next = await deref(value[i], `${path}[${i}]`);
    if (next !== value[i]) changed = true;
    out.push(next);
  }
  return changed ? out : value;
}

async function derefObject(value: Record<string, unknown>, path: string): Promise<unknown> {
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    const next = await deref(child, path ? `${path}.${key}` : key);
    if (next !== child) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

async function deref(value: unknown, path: string): Promise<unknown> {
  if (isCredentialRef(value)) {
    return resolveCredentialValue(value, INSTANCE_SCOPE, {
      caller: "config:instance",
      purpose: path,
    });
  }
  if (Array.isArray(value)) return derefArray(value, path);
  if (isPlainObject(value)) return derefObject(value, path);
  return value;
}

/**
 * Resolve every `{ ref: "credential", key }` in an operator config against the
 * instance scope of the credential store.
 *
 * Throws `CredentialNotFoundError` when a reference names a key with no value —
 * at boot, naming the key and the scope. A deployment whose config points at a
 * secret nobody seeded should not start and then fail per request at the vendor.
 * A config with no references never touches the store, so a caller that has not
 * installed one (a unit test loading an `instance.json`) is unaffected.
 */
export async function resolveInstanceCredentialRefs<T>(config: T): Promise<T> {
  return (await deref(config, "")) as T;
}
