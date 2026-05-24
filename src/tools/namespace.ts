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
 * The scope a namespaced tool name dispatches into.
 *
 * Stage 2 had one axis — the workspace. The identity app surface adds a
 * second: tools that belong to the IDENTITY (conversations, files,
 * automations) span every workspace and authorize by `ownerId`, so they
 * carry no workspace. A namespaced tool name is therefore
 * `<scope>-<toolName>` where the leading segment is either a workspace id
 * (`ws_<id>`) or the identity sentinel (`me`).
 */
export type ToolScope =
  | { readonly kind: "workspace"; readonly wsId: string }
  | { readonly kind: "identity" };

/**
 * Sentinel scope segment for identity-scoped tool names (`me-<tool>`).
 *
 * Safe against collision: a workspace id must match
 * `WORKSPACE_ID_RE = ^ws_[a-z0-9_]{1,64}$`, which `me` can never satisfy
 * (no `ws_` prefix), so the first-`-` split stays unambiguous.
 */
export const IDENTITY_SCOPE = "me";

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

/**
 * Build an identity-scoped tool name: `me-<name>`.
 *
 * The identity counterpart to `namespacedToolName`. Used by the
 * cross-workspace aggregator for tools whose placement scope is
 * `identity` (conversations, files, automations) and by the web bridge
 * when an identity app's iframe dispatches a tool. Throws
 * `InvalidNamespacedToolNameInput` on an empty/non-string name — same
 * fail-loud posture as the workspace builder.
 */
export function identityToolName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      IDENTITY_SCOPE,
      String(name),
      "empty_tool_name",
      "[tools/namespace] identityToolName: tool name is required (non-empty string)",
    );
  }
  return `${IDENTITY_SCOPE}-${name}`;
}

// ── Parsing ───────────────────────────────────────────────────────

/**
 * Parse a namespaced tool name into `{ scope, toolName }`.
 *
 * Grammar: `<scope>-<toolName>`, split on the **first** `-`. The leading
 * segment is the scope:
 *   - `me`        → `{ kind: "identity" }`
 *   - `ws_<id>`   → `{ kind: "workspace", wsId }`
 *
 * Neither a workspace id nor `me` contains `-` (workspace ids match
 * `^ws_[a-z0-9_]{1,64}$`), so the first `-` is always the scope
 * boundary; tool names may contain `-` themselves and round-trip
 * cleanly: `parseNamespacedToolName("ws_helix-foo-bar")` →
 * `{ scope: { kind: "workspace", wsId: "ws_helix" }, toolName: "foo-bar" }`.
 *
 * Why `-` and not `/`: LLM provider tool-name validators (OpenAI,
 * Anthropic, ...) typically constrain tool names to
 * `[a-zA-Z0-9_-]{1,128}`, rejecting `/`. The separator must satisfy
 * that external regex AND remain unambiguous against the scope grammar.
 * `-` is the only single-char that fits both.
 *
 * Throws `UnknownNamespacedToolName` on:
 *   - Input not a string, or empty.
 *   - No `-` separator (`"crm.search"`).
 *   - Empty scope component (`"-foo"`).
 *   - Empty tool name component (`"ws_helix-"`, `"me-"`).
 *   - Scope component that is neither `me` nor a valid `ws_<id>`.
 *
 * Never returns `null`/`undefined`. Never silently falls back to a
 * "current workspace" — that decision belongs to the orchestrator, and
 * only after this primitive has confirmed the input *is* namespaced.
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
  if (sepIdx < 0) {
    throw new UnknownNamespacedToolName(
      s,
      "missing_separator",
      `[tools/namespace] parseNamespacedToolName: missing "-" separator in "${s}"`,
    );
  }
  const head = s.slice(0, sepIdx);
  const toolName = s.slice(sepIdx + 1);
  if (head.length === 0) {
    throw new UnknownNamespacedToolName(
      s,
      "empty_scope",
      `[tools/namespace] parseNamespacedToolName: empty scope in "${s}"`,
    );
  }
  if (toolName.length === 0) {
    throw new UnknownNamespacedToolName(
      s,
      "empty_tool_name",
      `[tools/namespace] parseNamespacedToolName: empty tool name in "${s}"`,
    );
  }
  if (head === IDENTITY_SCOPE) {
    return { scope: { kind: "identity" }, toolName };
  }
  if (WORKSPACE_ID_RE.test(head)) {
    return { scope: { kind: "workspace", wsId: head }, toolName };
  }
  throw new UnknownNamespacedToolName(
    s,
    "invalid_scope",
    `[tools/namespace] parseNamespacedToolName: invalid scope "${head}" in "${s}" (expected "${IDENTITY_SCOPE}" or a valid ws_<id>)`,
  );
}

/**
 * Best-effort bare tool name for read-side consumers.
 *
 * If `s` is a namespaced name (`ws_<id>-<toolName>`), return the
 * `<toolName>` portion; otherwise return `s` unchanged. Unlike
 * `parseNamespacedToolName` this NEVER throws — it exists for the
 * read-side surfaces (tool surfacing in `runtime/tools.ts`, Layer-3
 * skill affinity in `skills/select.ts`, the engine's system-tool
 * release guard) that operate on tool lists mixing namespaced
 * (cross-workspace) and bare (pre-namespace, system, or test) names and
 * must classify both. Dispatch keeps using the strict parser, where an
 * unparseable name MUST fail loud.
 *
 * Implemented in terms of `parseNamespacedToolName` so the separator
 * and the `WORKSPACE_ID_RE` boundary stay defined in exactly one place:
 * a non-namespaced name (no `-`, or a leading segment that isn't a
 * valid `ws_<id>`) throws inside the parser and falls through to the
 * pass-through branch.
 */
export function bareToolName(s: string): string {
  try {
    return parseNamespacedToolName(s).toolName;
  } catch {
    return s;
  }
}
