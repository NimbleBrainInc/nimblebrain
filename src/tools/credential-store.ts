import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { IdentityContext } from "../identity/context.ts";
import { log } from "../observability/log.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { type CredentialValue, isCredentialRef } from "./credential-ref.ts";
import {
  CredentialSealError,
  type CredentialSealer,
  type CredentialSealFailure,
  isSealedValue,
  parseSealedValue,
} from "./credential-seal.ts";
import { Redacted } from "./redacted.ts";

/**
 * The scope a secret belongs to — which is to say, who owns it.
 *
 *   - `instance` — the operator's own keys: LLM providers, broker and gateway
 *     credentials, the IdP key. One set per deployment, referenced from
 *     `nimblebrain.json` / `instance.json`, and writable only from the CLI or
 *     the config file. No tenant reaches this scope.
 *   - `workspace` — a workspace's shared secrets: an OAuth `client_secret`, a
 *     connection string a customer owns. Two workspaces that install the same
 *     connector hold independent values, so an installed catalog entry can
 *     point at "the workspace's key" and mean a different secret per tenant.
 *   - `user` — an identity's own secrets, reachable across the workspaces they
 *     belong to. The home a personal connector's records move onto.
 *
 * A discriminated union rather than an optional `wsId`, because the three roots
 * are genuinely different owners and a missing id must be a type error, not a
 * silent fall back to a pooled directory.
 */
export type CredentialScope =
  | { kind: "instance" }
  | { kind: "workspace"; wsId: string }
  | { kind: "user"; userId: string };

/** Stable, loggable rendering of a scope — `instance`, `workspace:ws_…`, `user:usr_…`. */
export function credentialScopeLabel(scope: CredentialScope): string {
  switch (scope.kind) {
    case "instance":
      return "instance";
    case "workspace":
      return `workspace:${scope.wsId}`;
    case "user":
      return `user:${scope.userId}`;
  }
}

/**
 * Who is reading a secret and why. Required on every `get`, and stamped on the
 * audit event the returned secret emits when it is actually revealed.
 *
 * `caller` is the code path (`transport:header`, `oauth:client_secret`), stable
 * enough to group by. `purpose` is the concrete thing being done (`connect
 * ai-granola-mcp`), which is what makes a line in the log answer "why did this
 * key get read at 03:14".
 */
export interface CredentialRead {
  caller: string;
  purpose: string;
}

/** One key's presence and age. Never its value — this is what listing returns. */
export interface CredentialKeyInfo {
  key: string;
  /** Last write, ISO 8601. */
  updatedAt: string;
}

/**
 * The one door every secret goes through.
 *
 * The interface is the boundary between call sites and the storage backend.
 * Which backend answers is configuration (`secrets.backend`), and no caller
 * learns which one did: the same `FileCredentialStore` holds plaintext or
 * AES-256-GCM depending on `secrets.config.seal`, and a future vault backend
 * would be a second registration rather than a change here.
 * That promise is only worth something while this is the ONLY path, which is
 * why the store is constructed once (at the composition root, where the event
 * sink lives) and reached through `runtime.getCredentialStore()` rather than
 * built where it is needed.
 *
 * Values come back wrapped in `Redacted<string>` so they survive an accidental
 * logger or stack trace as `"[redacted]"`. Code that needs the actual secret
 * calls `.reveal()` at the boundary it is used (HTTP header, token exchange) —
 * and that call is what emits the audit event, so a presence probe that never
 * reveals costs no log line.
 */
export interface CredentialStore {
  /** Resolve a secret. Returns `null` if the key is not set. */
  get(scope: CredentialScope, key: string, read: CredentialRead): Promise<Redacted<string> | null>;
  /** Set or replace a secret atomically. */
  put(scope: CredentialScope, key: string, value: string): Promise<void>;
  /** Remove a secret. No-op if absent. */
  delete(scope: CredentialScope, key: string): Promise<void>;
  /** Every key set in a scope, with its last-write time. Never any value. */
  list(scope: CredentialScope): Promise<CredentialKeyInfo[]>;
  /**
   * Bring what is stored into line with what this backend is configured to
   * hold, once, at boot. Optional: a backend with nothing to reconcile omits it
   * and the kernel's `await store.reconcile?.()` costs nothing.
   *
   * It is a lifecycle hook and not a fifth operation — no caller of `get` or
   * `put` ever reaches it, and nothing above the composition root learns which
   * backend answered. A desired-state-to-actual-state invariant belongs here,
   * where it runs on every boot, rather than in a path someone has to remember
   * to call.
   */
  reconcile?(): Promise<void>;
}

/**
 * Validate a key. We reuse the same shape as connector-credential keys —
 * dotted-namespace, alphanumerics, hyphen, underscore — because the key
 * becomes a filesystem path component.
 *
 *   "acme.db_url"           ✓
 *   "google.oauth-client"   ✓
 *   "../evil"               ✗
 *   "with/slash"            ✗
 */
const KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function assertValidKey(key: string): void {
  if (typeof key !== "string" || !KEY_RE.test(key) || key === "." || key === "..") {
    throw new Error(
      `[credential-store] invalid key: "${key}". ` +
        `Must match /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/ and not be "." or "..".`,
    );
  }
}

/**
 * Where the person reading this error goes to set the missing key.
 *
 * A workspace secret has a UI: the connector's page under Settings → Connectors
 * collects it and writes it through the same door. Naming that instead of a tool
 * call matters more than the wording suggests — the tool call is reachable only
 * by typing the value into a conversation, which puts a plaintext credential in
 * the transcript, the model's context, and wherever that conversation persists.
 *
 * The other two scopes have no such surface. An instance key is the deployment's
 * own (LLM providers, the IdP, brokers) and belongs to whoever edits config; a
 * user key is the caller's own identity-plane credential, written by the flow
 * that acquired it.
 */
function remedyFor(scope: CredentialScope): string {
  switch (scope.kind) {
    case "workspace":
      return "Set it on the connector's page under Settings → Connectors";
    case "instance":
      return "Set it in the deployment's credential store";
    case "user":
      return "Reconnect the connector to acquire it";
  }
}

/** Thrown when a config reference names a key the store has nothing for. */
export class CredentialNotFoundError extends Error {
  constructor(
    readonly scope: CredentialScope,
    readonly key: string,
    what: string,
  ) {
    super(
      `[credential-store] no secret at key "${key}" in scope ${credentialScopeLabel(scope)} ` +
        `(needed for ${what}). ${remedyFor(scope)}, or remove the reference.`,
    );
    this.name = "CredentialNotFoundError";
  }
}

/**
 * Read a file that is not sealed.
 *
 * The trailing-newline trim is an affordance for `echo "secret" > file`, which
 * is how the docs and every hand-seeded instance key have always written one.
 * It is also lossy: a secret that genuinely ends in a newline comes back
 * without it, and there is no way for this path to tell the two apart. That is
 * the cost of accepting bytes a text editor produced, and it is why it belongs
 * to the legacy path alone — a sealed value carries its own length and
 * round-trips exactly.
 */
function legacyPlaintext(raw: string): string {
  return raw.replace(/\n$/, "");
}

/** Running counts across one sweep. */
interface ResealTally {
  resealed: number;
  current: number;
  skipped: number;
  /** Scope roots that exist and could not be listed. Holds strict mode off. */
  unreadable: number;
}

/**
 * "Nothing here" and "could not look" are different answers, and only the first
 * is benign.
 *
 * A directory the sweep cannot LIST can still have its files opened by path, so
 * treating an unlistable root as an empty one lets the sweep report a clean
 * finish over secrets it never saw — and strict mode then refuses the legitimate
 * plaintext underneath it.
 */
function isMissingDirectory(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Every way a stored secret can fail to become a usable value, as one closed
 * set — the codec's three, plus the two only the store can see. It is what the
 * audit line carries, so a query over the log can group by cause without
 * parsing prose.
 */
type SealFailureReason =
  | CredentialSealFailure
  | "no_sealer"
  | "plaintext_refused"
  | "reseal_skipped";

/**
 * What an operator does about each way an open can fail. Separate strings
 * because they are separate repairs: put the key back, restore the byte-exact
 * file, or find out who wrote a file this runtime never sealed.
 */
const REMEDIES: Record<CredentialSealFailure, (kids: readonly string[]) => string> = {
  unknown_kid: (kids) =>
    `no key in the ring produced that kid (ring: ${kids.join(", ")}). Load the key that did — ` +
    "a key dropped from the ring stops opening everything sealed under it",
  auth_failed: () =>
    "it failed authentication — the file was modified after sealing, or the key behind its kid " +
    "is not the one that sealed it",
  malformed: () =>
    "it starts with the sealed-value magic but is not a well-formed sealed value. Sealed bytes are " +
    "exact: a copy made with `echo` appends a newline and a truncated write cuts a field. Restore " +
    "the file byte-for-byte, or set the secret again",
};

/**
 * A secret that reports its own use.
 *
 * The audit event fires on `reveal()`, not on the read that produced it, so the
 * log records secrets that were *presented* rather than secrets that were
 * looked up. That distinction is load-bearing: the connectors list probes for a
 * configured `client_secret` on every catalog entry it renders, and auditing
 * those probes would bury the handful of real uses under a page-load's worth of
 * noise while claiming each was a use.
 *
 * Emitted at most once per instance. One `get` yields one line however many
 * times its value is presented — otherwise a long-lived `fetch` wrapper holding
 * one secret would write a line per outbound HTTP request.
 */
class AuditedSecret extends Redacted<string> {
  /** Set only for a value still sealed on disk. Called at most once. */
  #open: (() => string) | undefined;
  #outcome: { ok: true; value: string } | { ok: false; error: unknown } | undefined;
  #onFirstReveal: (() => void) | undefined;

  constructor(source: string | (() => string), onFirstReveal: () => void) {
    // A lazy source has nothing to hand the base class, and the sealed bytes
    // deliberately do NOT go there — `reveal` is overridden and the base's field
    // is private, so the placeholder is unreachable, but a later
    // `super.reveal()` over ciphertext is the exact mistake this file exists to
    // prevent.
    super(typeof source === "string" ? source : "");
    if (typeof source !== "string") this.#open = source;
    this.#onFirstReveal = onFirstReveal;
  }

  override reveal(): string {
    // Opening comes first: a value that could not be opened was never revealed,
    // so it must not write an `audit.credential_read` line saying it was.
    const value = this.#resolve();
    const emit = this.#onFirstReveal;
    if (emit) {
      this.#onFirstReveal = undefined;
      emit();
    }
    return value;
  }

  /** Open once, then answer from the outcome — success or failure alike, so a
   *  caller that reveals twice does not audit one failure twice. */
  #resolve(): string {
    if (!this.#open) return super.reveal();
    if (!this.#outcome) {
      try {
        this.#outcome = { ok: true, value: this.#open() };
      } catch (error) {
        this.#outcome = { ok: false, error };
      }
    }
    if (!this.#outcome.ok) throw this.#outcome.error;
    return this.#outcome.value;
  }
}

/**
 * File-backed `CredentialStore`. Each secret lives in its own file under its
 * scope's root:
 *
 *   instance   <workDir>/credentials/secrets/<key>
 *   workspace  <workDir>/workspaces/<wsId>/credentials/secrets/<key>
 *   user       <workDir>/users/<userId>/credentials/secrets/<key>
 *
 * Files are written 0o600 via atomic temp+rename; the parent `secrets/`
 * directory is created 0o700. A `put` on an existing key replaces it in place,
 * which is the whole of rotating a *value* — the next read gets the new one and
 * no config was touched.
 *
 * **What is IN those files depends on the `sealer`.** With none, the secret
 * verbatim: secure enough for a trusted local disk and nothing more. With one,
 * `NBS1.…` — AES-256-GCM, for any deployment whose disk, snapshots or backups
 * outlive the process. Which it is comes from `secrets.config.seal` at the
 * backend, never from a build flag or the presence of an environment variable.
 *
 * The two are not two stores. The file mechanics are identical, the audit is
 * identical, and a deployment that turns sealing on keeps reading the plaintext
 * files already there, and {@link reconcile} re-wraps every one of them on the
 * next boot.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #workDir: string;
  readonly #eventSink: EventSink | undefined;
  readonly #sealer: CredentialSealer | undefined;
  /**
   * Set by a clean {@link reconcile}: from then on, a plaintext file is refused
   * rather than read.
   *
   * Sealing buys confidentiality. THIS is what buys integrity. While plaintext
   * is accepted indefinitely, anyone who can write the secrets directory —
   * without holding the key — can replace a sealed file with a plaintext one
   * holding a credential of their choosing and have it used. Once every secret
   * is sealed, a plaintext file appearing there is either an operator who should
   * have used the CLI or an injection, and both deserve the same answer.
   */
  #strictPlaintextRefusal = false;

  constructor(workDir: string, opts?: { eventSink?: EventSink; sealer?: CredentialSealer }) {
    this.#workDir = workDir;
    this.#eventSink = opts?.eventSink;
    this.#sealer = opts?.sealer;
  }

  /**
   * The secrets directory for a scope.
   *
   * Every arm routes through the typed context that owns its tree —
   * `WorkspaceContext` for a workspace, `IdentityContext` for a user — so the id
   * is validated at the single place that validates it and no arm hand-builds a
   * path under `workspaces/` or `users/`. The instance arm has no owner tree
   * above it; `<workDir>/credentials/` is its root by definition.
   */
  #dir(scope: CredentialScope): string {
    switch (scope.kind) {
      case "instance":
        return join(this.#workDir, "credentials", "secrets");
      case "workspace":
        return new WorkspaceContext({ wsId: scope.wsId, workDir: this.#workDir }).getDataPath(
          "credentials",
          "secrets",
        );
      case "user":
        return join(
          new IdentityContext({ userId: scope.userId, workDir: this.#workDir }).getRoot(),
          "credentials",
          "secrets",
        );
    }
  }

  #filePath(scope: CredentialScope, key: string): string {
    assertValidKey(key);
    return join(this.#dir(scope), key);
  }

  async get(
    scope: CredentialScope,
    key: string,
    read: CredentialRead,
  ): Promise<Redacted<string> | null> {
    const path = this.#filePath(scope, key);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    // A sealed value is opened on the first `reveal()`, never here. `get`
    // WITHOUT a reveal is the presence probe: connection-state derivation runs
    // it over every installed connector on a page load, and boot runs it over
    // every URL connector before starting any of them. Opening here makes one
    // unopenable value throw at all of those — a single bad secret fails the
    // whole tenant's boot and hides the UI that would repair it. Deferring puts
    // the failure on the one connection that uses the secret, which is already
    // isolated per connector. It is the same reason the audit line fires on the
    // reveal rather than on the read that produced it.
    const value = isSealedValue(raw)
      ? () => this.#open(scope, key, raw)
      : this.#strictPlaintextRefusal
        ? () => this.#refusePlaintext(scope, key)
        : legacyPlaintext(raw);
    return new AuditedSecret(value, () => this.#auditReveal(scope, key, read));
  }

  async put(scope: CredentialScope, key: string, value: string): Promise<void> {
    const dir = this.#dir(scope);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      // mkdir succeeded; chmod failure is non-fatal — file mode 0o600 below
      // still protects the contents.
    }
    const path = this.#filePath(scope, key);
    // Leading dot, so the temp name falls OUTSIDE the key grammar: a `put` that
    // dies between write and rename leaves this file behind, and `list` filters
    // by that grammar. `assertValidKey` refuses a key starting with a dot, so
    // this can never collide with a real one, and keeping the key in the name
    // keeps two concurrent puts on different keys from sharing a temp path.
    const tmp = join(dir, `.${key}.tmp.${randomBytes(4).toString("hex")}`);
    // Sealed bytes are exact and carry no trailing newline, which is what makes
    // a sealed value round-trip byte-for-byte where a plaintext one cannot.
    const bytes = this.#sealer ? this.#sealer.seal(credentialScopeLabel(scope), key, value) : value;
    await writeFile(tmp, bytes, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  async delete(scope: CredentialScope, key: string): Promise<void> {
    const path = this.#filePath(scope, key);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // Concurrent removal — fine.
    }
  }

  async list(scope: CredentialScope): Promise<CredentialKeyInfo[]> {
    const dir = this.#dir(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // No directory means no secrets, which is a legitimate empty answer.
      return [];
    }
    const out: CredentialKeyInfo[] = [];
    for (const name of names) {
      // A `put` that died between write and rename leaves a temp file. It is
      // not a key and must not read as one.
      if (!KEY_RE.test(name)) continue;
      try {
        const s = await stat(join(dir, name));
        if (!s.isFile()) continue;
        out.push({ key: name, updatedAt: new Date(s.mtimeMs).toISOString() });
      } catch {
        // Removed between readdir and stat.
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Open a value that claims to be sealed. Throws if it cannot be.
   *
   * **It is never read as plaintext.** Not when no sealer is configured, not
   * when the ring has no matching key, not when the tag fails. Falling through
   * on any of those would hand `NBS1.…` to a vendor as an API key — silently,
   * for every credential, and most likely during exactly the incident that
   * caused it: removing the config block, or rolling the image back below the
   * release that introduced sealing. A loud failure at that moment is recoverable
   * and a quiet one is not.
   *
   * Reached from the first `reveal()`, never from `get`.
   */
  #open(scope: CredentialScope, key: string, raw: string): string {
    const label = credentialScopeLabel(scope);
    const wantedKid = parseSealedValue(raw)?.kid;
    // The codec's own reason travels, onto the error and onto the audit line.
    // These are different operator problems with different repairs, and
    // collapsing them makes a stray trailing newline read as a wrong key.
    // Narrower than what the audit line accepts: this path only ever reports a
    // codec failure or a missing sealer, and both become a `CredentialSealError`.
    const fail = (reason: CredentialSealFailure | "no_sealer", remedy: string): never => {
      this.#auditSealFailure(scope, key, wantedKid, reason);
      throw new CredentialSealError(
        reason === "no_sealer" ? "unknown_kid" : reason,
        `the value at key "${key}" in scope ${label} is sealed${
          wantedKid ? ` under kid ${wantedKid}` : ""
        } and cannot be opened: ${remedy}`,
      );
    };
    if (!this.#sealer) {
      return fail(
        "no_sealer",
        "this runtime has no sealing key configured. Restore `secrets.config.seal` and the key it names — " +
          "removing them does not make sealed files readable again, it makes them unreadable",
      );
    }
    try {
      return this.#sealer.open(label, key, raw);
    } catch (err) {
      const reason = err instanceof CredentialSealError ? err.reason : "auth_failed";
      return fail(reason, REMEDIES[reason](this.#sealer.kids));
    }
  }

  /**
   * A failed open, on the same stream the reads go to. A tag failure is either
   * tampering or a misconfigured key and both belong in the audit log — scope,
   * key and the wanted kid, which is a MAC over a constant and discloses
   * nothing. **Never a value:** the bytes we could not open are still the
   * ciphertext of a live credential.
   */
  #auditSealFailure(
    scope: CredentialScope,
    key: string,
    wantedKid: string | undefined,
    reason: SealFailureReason,
  ): void {
    const event: EngineEvent = {
      type: "audit.credential_seal_failure",
      data: {
        scope: credentialScopeLabel(scope),
        key,
        reason,
        ...(wantedKid ? { wantedKid } : {}),
        ...(scope.kind === "workspace" ? { workspaceId: scope.wsId } : {}),
        ...(scope.kind === "user" ? { userId: scope.userId } : {}),
      },
    };
    this.#eventSink?.emit(event);
  }

  /**
   * Refuse a plaintext file after a clean sweep. Lazy, like every other refusal
   * here: a plaintext file planted by someone who can write the directory must
   * not be able to fail a presence probe, or writing one becomes a way to stop
   * the tenant booting.
   */
  #refusePlaintext(scope: CredentialScope, key: string): never {
    const label = credentialScopeLabel(scope);
    this.#auditSealFailure(scope, key, undefined, "plaintext_refused");
    throw new Error(
      `[credential-store] the value at key "${key}" in scope ${label} is plaintext, and this ` +
        "store sealed every secret it found at boot. A plaintext file appearing afterwards was " +
        "not written through the store — set the secret again rather than editing the file.",
    );
  }

  /**
   * Re-seal everything on disk under the current sealing key, once, at boot.
   *
   * Walks the three scope roots and rewrites any secret that is legacy
   * plaintext or sealed under a key that is no longer `keys[0]`, through the
   * same atomic temp+rename `put` uses, with a fresh salt and IV each time.
   * Rotation is then three steps with nothing to schedule: put the new key at
   * the front of the ring, restart, and this re-wraps everything on the way up
   * while the outgoing key still opens whatever it has not reached.
   *
   * Lazy-on-read was the alternative and is rejected: a secret nobody reads
   * would stay plaintext forever, and the rarely-read key is exactly the one an
   * operator forgets they have.
   *
   * `archived/<wsId>/` is deliberately NOT walked. A deleted workspace's
   * secrets are a retention problem, not an encryption one — they should be
   * gone, and sealing them would make them look handled instead.
   */
  async reconcile(): Promise<void> {
    const sealer = this.#sealer;
    // Nothing to reconcile without one, and strict mode stays off: an unsealed
    // deployment is plaintext by design, not by omission.
    if (!sealer) return;

    const tally: ResealTally = { resealed: 0, current: 0, skipped: 0, unreadable: 0 };
    for (const scope of await this.#everyScope(tally)) {
      await this.#resealScope(scope, sealer, tally);
    }

    // Only a sweep that finished has proved every secret is sealed, so only a
    // sweep that finished has earned the right to call a plaintext file an
    // injection. A root it could not list counts against that as much as a file
    // it could not open: both mean there are secrets it did not see.
    if (tally.skipped === 0 && tally.unreadable === 0) {
      this.#strictPlaintextRefusal = true;
    }
    log.info("[credential-store] sealed-secret reconcile complete", {
      resealed: tally.resealed,
      alreadyCurrent: tally.current,
      skipped: tally.skipped,
      unreadable: tally.unreadable,
      strictPlaintextRefusal: this.#strictPlaintextRefusal,
    });
  }

  /** Every secret in one scope, counted into the running tally. */
  async #resealScope(
    scope: CredentialScope,
    sealer: CredentialSealer,
    tally: ResealTally,
  ): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#dir(scope));
    } catch (err) {
      if (isMissingDirectory(err)) return; // no directory means no secrets here
      tally.unreadable++;
      log.warn("[credential-store] could not list a secrets directory; not sweeping it", {
        scope: credentialScopeLabel(scope),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const key of names) {
      // The same filter `list` applies: a temp file left by a killed `put` is
      // not a key and must not be rewritten as one.
      if (!KEY_RE.test(key)) continue;
      const outcome = await this.#resealOne(scope, key, sealer);
      // `ignored` is not counted: a directory sitting where a key should be is
      // not a secret that was already current, and a tally an operator reads
      // should not say it was.
      if (outcome !== "ignored") tally[outcome]++;
    }
  }

  /**
   * One file. Returns what happened rather than throwing, because **one
   * unreadable secret must not stop a tenant booting** — it would take the whole
   * deployment down over a key nothing uses, and the operator's only visible
   * symptom would be a crash loop.
   *
   * A skip is not free, though: it holds strict mode off, so the deployment
   * keeps accepting plaintext until someone resolves the file.
   */
  async #resealOne(
    scope: CredentialScope,
    key: string,
    sealer: CredentialSealer,
  ): Promise<"resealed" | "current" | "skipped" | "ignored"> {
    const label = credentialScopeLabel(scope);
    const path = join(this.#dir(scope), key);
    try {
      const before = await stat(path);
      if (!before.isFile()) return "ignored";
      const raw = await readFile(path, "utf-8");

      let value: string;
      if (isSealedValue(raw)) {
        if (parseSealedValue(raw)?.kid === sealer.sealingKid) return "current";
        value = sealer.open(label, key, raw);
      } else {
        value = legacyPlaintext(raw);
      }

      await this.put(scope, key, value);
      // `list` derives `updatedAt` from mtime, so without this the first boot
      // after enabling sealing — and every rotation after — reports every
      // secret as just-changed. "Last set" would quietly become "last sealed",
      // destroying the only provenance `list` offers.
      await utimes(path, before.atime, before.mtime);
      return "resealed";
    } catch (err) {
      this.#auditSealFailure(scope, key, undefined, "reseal_skipped");
      log.warn("[credential-store] could not re-seal a secret; leaving it as it is", {
        scope: label,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return "skipped";
    }
  }

  /**
   * Every scope that has a secrets directory today.
   *
   * Ids come from the directory listing and go straight back through `#dir`,
   * which validates them in the typed context that owns each tree — so a junk
   * directory name is refused there rather than turned into a path here.
   */
  async #everyScope(tally: ResealTally): Promise<CredentialScope[]> {
    const scopes: CredentialScope[] = [{ kind: "instance" }];
    const owners: [string, (id: string) => CredentialScope][] = [
      ["workspaces", (wsId) => ({ kind: "workspace", wsId })],
      ["users", (userId) => ({ kind: "user", userId })],
    ];
    for (const [dirName, toScope] of owners) {
      let ids: string[];
      try {
        ids = await readdir(join(this.#workDir, dirName));
      } catch (err) {
        if (!isMissingDirectory(err)) {
          // Every scope under this root is unseen, not absent.
          tally.unreadable++;
          log.warn("[credential-store] could not list an owner directory; not sweeping under it", {
            dir: dirName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      for (const id of ids) {
        const scope = toScope(id);
        try {
          this.#dir(scope);
        } catch {
          continue; // not an id this runtime owns a tree for
        }
        scopes.push(scope);
      }
    }
    return scopes;
  }

  #auditReveal(scope: CredentialScope, key: string, read: CredentialRead): void {
    const event: EngineEvent = {
      type: "audit.credential_read",
      data: {
        scope: credentialScopeLabel(scope),
        key,
        caller: read.caller,
        purpose: read.purpose,
        ...(scope.kind === "workspace" ? { workspaceId: scope.wsId } : {}),
        ...(scope.kind === "user" ? { userId: scope.userId } : {}),
      },
    };
    this.#eventSink?.emit(event);
  }
}

// ── The installed store ──────────────────────────────────────────────

let _installed: CredentialStore | undefined;

/**
 * Install the process's credential store. Called once at the composition root
 * (`Runtime.start`), which is the only place that holds both the work directory
 * and the event sink a read must be attributable through.
 *
 * A module-level handle rather than a threaded argument because the readers are
 * leaves — `remote-transport.ts` resolving a header reference, the boot-time
 * instance-key resolution — and threading a store through the transport factory
 * would put it in every caller's signature to serve the one case that dereferences.
 */
export function setCredentialStore(store: CredentialStore): void {
  _installed = store;
}

/**
 * The installed store. Throws when nothing installed one, because the only way
 * to reach here is a config reference that has to be resolved: answering
 * "there is no store" with an empty value would turn a missing secret into a
 * blank header and a 401 a hop away.
 */
export function requireCredentialStore(): CredentialStore {
  if (!_installed) {
    throw new Error(
      '[credential-store] no credential store installed; a `{ ref: "credential" }` ' +
        "reference cannot be resolved (call setCredentialStore() at the composition root)",
    );
  }
  return _installed;
}

/** The installed store, or undefined. For callers that have a literal fallback. */
export function getCredentialStore(): CredentialStore | undefined {
  return _installed;
}

/** Test-only. Drop the installed store so a suite starts from none. */
export function _resetCredentialStoreForTest(): void {
  _installed = undefined;
}

/**
 * Resolve a config field that is either the secret itself or a reference to one.
 *
 * The single dereference site. A literal passes through untouched — the
 * reference is an option, not a requirement — and a reference to a key with no
 * value throws {@link CredentialNotFoundError}, naming both the key and the
 * scope. Failing loud is the point: the alternative is an empty header and a
 * vendor 401 that names neither.
 */
export async function resolveCredentialValue(
  value: CredentialValue,
  scope: CredentialScope,
  read: CredentialRead,
): Promise<string> {
  if (!isCredentialRef(value)) return value;
  const wrapped = await requireCredentialStore().get(scope, value.key, read);
  if (!wrapped) throw new CredentialNotFoundError(scope, value.key, read.purpose);
  return wrapped.reveal();
}
