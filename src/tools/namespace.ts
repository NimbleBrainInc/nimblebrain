/**
 * Cross-workspace tool name primitive.
 *
 * **Single construction site for `ws_<id>-<toolName>`.** No other code
 * site in `src/` may build or parse this form by hand — the convention
 * is enforced by the `check:tool-namespace` AST lint
 * (`scripts/check-tool-namespace.ts`). See Stage 2 `SPEC_REFERENCE.md`
 * § "Constraints" item 6.
 *
 * **Separator: `-`.** Workspace ids match
 * `WORKSPACE_ID_PATTERN = ^ws_[a-z0-9_]{1,64}$` (no `-`), so the first
 * `-` is unambiguously the workspace/tool boundary. We chose `-` over
 * `/` because LLM provider tool-name validators (OpenAI, Anthropic,
 * etc.) constrain names to `[a-zA-Z0-9_-]{1,128}` — `/` is rejected
 * at the provider boundary, breaking tool registration. `-` satisfies
 * both the provider regex and our unambiguity requirement.
 *
 * Design rules (matching Stage 1 lessons):
 *
 * 1. **Strict invariants over defensive defaults** (lesson 3). Every
 *    invalid shape throws — no `??` / `?? null` / `?? ""` fallbacks
 *    anywhere. The orchestrator (T004) catches `UnknownNamespacedToolName`
 *    and decides what to do; the primitive does not guess.
 * 2. **Single source of truth for `wsId` validation.**
 *    `WORKSPACE_ID_RE` is imported from `src/workspace/workspace-store.ts`
 *    and never redefined locally. Same defense applies here as for the
 *    credential-store primitives: a wsId carrying path-traversal
 *    (`../etc`) or whitespace (`ws helix`) must be rejected at the
 *    construction site, not later.
 * 3. **First-`-` split** when parsing. Tool names may contain `-`
 *    themselves (e.g. `crm-tool__search`); the first `-` is the
 *    workspace boundary, the rest is the tool name verbatim.
 *    `parseNamespacedToolName("ws_helix-foo-bar")` returns
 *    `{ wsId: "ws_helix", toolName: "foo-bar" }`. Asserted in
 *    `test/unit/tools/namespace.test.ts`.
 * 4. **No `as unknown as T` casts.** Pure string functions; type flow
 *    is direct.
 */

import { WORKSPACE_ID_RE } from "../workspace/workspace-store.ts";

// ── Scope ──────────────────────────────────────────────────────────

/**
 * The scope a tool name dispatches into.
 *
 * Two axes, distinguished by presence of a workspace prefix:
 *
 *   - **workspace** — `ws_<id>-<toolName>`. A workspace-*replicated* tool:
 *     the same app installed in two workspaces is two distinct tools, each
 *     carrying its workspace. Dispatched against `WorkspaceContext(wsId)`.
 *   - **global** — bare `<toolName>` (no prefix). A *singleton*: platform
 *     system tools (`nb__*`) and identity-owned apps (`conversations__*`,
 *     later `files__*` / `automations__*`). There's one of each, so it
 *     carries no workspace. Dispatched against the identity / global
 *     context (the orchestrator validates the source against a kernel-
 *     owned global-source set before routing).
 *
 * The workspace prefix means "this specific workspace"; its ABSENCE means
 * global. No `me-`-style sentinel — a bare name is global by construction.
 */
export type ToolScope =
  | { readonly kind: "workspace"; readonly wsId: string }
  | { readonly kind: "global" };

// ── Errors ─────────────────────────────────────────────────────────

/**
 * Thrown by `parseNamespacedToolName` when the input does not match
 * the `ws_<id>/<toolName>` shape, or when either component is invalid.
 *
 * The orchestrator catches this to distinguish "unparseable / unknown
 * tool name" from genuine tool errors. Don't conflate with
 * `WorkspaceNotFoundError` — this fires before the wsId is resolved
 * against the store.
 */
export class UnknownNamespacedToolName extends Error {
  /** The exact input string that failed to parse. */
  readonly input: string;
  /** Short machine-readable reason (`"missing_separator"`, `"invalid_wsid"`, `"empty_tool_name"`, `"empty_workspace_id"`). */
  readonly reason: string;

  constructor(input: string, reason: string, message: string) {
    super(message);
    this.name = "UnknownNamespacedToolName";
    this.input = input;
    this.reason = reason;
  }
}

/**
 * Thrown by `namespacedToolName` when either operand is invalid. Separate
 * class so callers can distinguish a malformed input string (parse-side)
 * from a malformed construction request (build-side); both are
 * programmer errors but they originate in different layers.
 */
export class InvalidNamespacedToolNameInput extends Error {
  readonly wsId: string;
  readonly toolName: string;
  readonly reason: string;

  constructor(wsId: string, toolName: string, reason: string, message: string) {
    super(message);
    this.name = "InvalidNamespacedToolNameInput";
    this.wsId = wsId;
    this.toolName = toolName;
    this.reason = reason;
  }
}

// ── Construction ──────────────────────────────────────────────────

/**
 * Build a namespaced tool name from a workspace id and a tool name.
 *
 * Returns `ws_<id>/<toolName>`. Throws `InvalidNamespacedToolNameInput`
 * on any invalid input:
 *   - `wsId` missing, empty, non-string, or failing `WORKSPACE_ID_RE`
 *     (path-traversal, whitespace, wrong prefix all rejected here).
 *   - `name` missing, empty, or non-string.
 *
 * No `??`/`||` defaulting; every invalid shape is fail-loud. The
 * orchestrator must surface the error rather than fall back to a
 * "current workspace."
 */
export function namespacedToolName(wsId: string, name: string): string {
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      String(wsId),
      String(name),
      "empty_workspace_id",
      "[tools/namespace] namespacedToolName: wsId is required (non-empty string)",
    );
  }
  if (!WORKSPACE_ID_RE.test(wsId)) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "invalid_wsid",
      `[tools/namespace] namespacedToolName: invalid wsId "${wsId}" (must match WORKSPACE_ID_RE)`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "empty_tool_name",
      "[tools/namespace] namespacedToolName: tool name is required (non-empty string)",
    );
  }
  return `${wsId}-${name}`;
}

// Global tools have NO builder: a global tool name IS its bare
// `<source>__<tool>` form (e.g. `nb__search`, `conversations__search`).
// There's nothing to prefix — absence of a `ws_<id>-` prefix is what
// makes a name global.

// ── Parsing ───────────────────────────────────────────────────────

/**
 * Parse a tool name into `{ scope, toolName }`.
 *
 * Grammar:
 *   - `ws_<id>-<toolName>` → `{ kind: "workspace", wsId }`, toolName is the
 *     remainder after the first `-`. Workspace ids can't contain `-`
 *     (`^ws_[a-z0-9_]{1,64}$`), so the first `-` is the workspace boundary;
 *     tool names may contain `-` and round-trip cleanly
 *     (`ws_helix-foo-bar` → wsId `ws_helix`, toolName `foo-bar`).
 *   - **bare** `<toolName>` (anything not matching the above) →
 *     `{ kind: "global" }`, toolName is the WHOLE input (no prefix to
 *     strip). Platform tools (`nb__search`) and identity-owned app tools
 *     (`conversations__search`) are global singletons.
 *
 * The workspace prefix means "this specific workspace"; its absence means
 * global. There is no `me-`-style sentinel.
 *
 * Why `-` and not `/`: LLM provider tool-name validators constrain names
 * to `[a-zA-Z0-9_-]{1,128}`, rejecting `/`. `-` satisfies that and is
 * unambiguous against the workspace-id pattern.
 *
 * Throws `UnknownNamespacedToolName` only on:
 *   - Input not a string, or empty.
 *   - A `ws_<id>-` workspace prefix with an EMPTY tool name (`"ws_helix-"`).
 *   - A leading segment that starts with `ws_` (a workspace attempt) but
 *     fails `WORKSPACE_ID_RE` — a malformed/hostile workspace id, surfaced
 *     rather than silently treated as a (bare) global name.
 *
 * Everything else resolves to a global name. The orchestrator still
 * fails loud on a bare name whose source isn't in the kernel global-source
 * set — that check belongs there (it owns the registry), not here.
 */
export function parseNamespacedToolName(s: string): { scope: ToolScope; toolName: string } {
  if (typeof s !== "string" || s.length === 0) {
    throw new UnknownNamespacedToolName(
      String(s),
      "empty_input",
      "[tools/namespace] parseNamespacedToolName: input is required (non-empty string)",
    );
  }
  const sepIdx = s.indexOf("-");
  if (sepIdx > 0) {
    const head = s.slice(0, sepIdx);
    if (WORKSPACE_ID_RE.test(head)) {
      const toolName = s.slice(sepIdx + 1);
      if (toolName.length === 0) {
        throw new UnknownNamespacedToolName(
          s,
          "empty_tool_name",
          `[tools/namespace] parseNamespacedToolName: empty tool name in "${s}"`,
        );
      }
      return { scope: { kind: "workspace", wsId: head }, toolName };
    }
    // A leading `ws_`-prefixed segment that isn't a valid id is a malformed
    // workspace attempt (typo / traversal / cross-tenant probe), not a
    // bare global name — surface it instead of silently globalizing.
    if (head.startsWith("ws_")) {
      throw new UnknownNamespacedToolName(
        s,
        "invalid_wsid",
        `[tools/namespace] parseNamespacedToolName: invalid workspace id "${head}" in "${s}"`,
      );
    }
  }
  // Bare: no workspace prefix. The whole name is the (global) tool name.
  return { scope: { kind: "global" }, toolName: s };
}

/**
 * Best-effort bare tool name for read-side consumers.
 *
 * If `s` is a workspace-namespaced name (`ws_<id>-<toolName>`), return the
 * `<toolName>` portion; for a bare/global name, return it unchanged. It
 * exists for the read-side surfaces (tool surfacing in `runtime/tools.ts`,
 * Layer-3 skill affinity in `skills/select.ts`, the engine's system-tool
 * release guard) that classify tool lists mixing workspace-namespaced and
 * bare names.
 *
 * Implemented in terms of `parseNamespacedToolName` so the separator and
 * the `WORKSPACE_ID_RE` boundary stay defined in one place: a global name
 * parses to `{ kind: "global", toolName: s }` (the whole name), so this
 * returns `s`; a workspace name returns the stripped tool name. The
 * try/catch guards the only throwing cases (empty input, malformed
 * `ws_<id>-` prefix) — those pass through unchanged too.
 */
export function bareToolName(s: string): string {
  try {
    return parseNamespacedToolName(s).toolName;
  } catch {
    return s;
  }
}
