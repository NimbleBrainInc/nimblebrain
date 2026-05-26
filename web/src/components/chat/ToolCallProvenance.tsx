// ---------------------------------------------------------------------------
// ToolCallProvenance — Stage 2 / T013, Q2
//
// Renders the inline tool-call row label for a transcript entry:
//
//     collateral.get_doc · Helix    [ok | error | running]
//
// The namespaced ground-truth string (`ws_helix-collateral__get_doc`)
// stays in the event log. This component is the render-time projection
// — workspace display name on the right, friendly tool name on the
// left, status pill at the end (Q2: "render workspace display-name +
// friendly tool name on the fly").
//
// Fallback contract (Q2): when the workspace is no longer in the
// user's list (removed, renamed, identity changed), render the raw
// `ws_<id>-<tool_name>` string — never default to the user's personal
// workspace name (a subtle correctness bug surfaced in the audit
// criteria).
//
// Namespace parsing flows through `parseNamespacedToolName` from
// `web/src/lib/namespaced-tool.ts`. Hand-built string-split on a
// presumed namespaced binding is forbidden — the task spec's audit
// grep would flag it.
// ---------------------------------------------------------------------------

import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { stripServerPrefix } from "../../lib/format";
import { parseNamespacedToolName } from "../../lib/namespaced-tool";
import { Badge } from "../ui/badge";

export type ToolCallProvenanceStatus = "ok" | "error" | "running";

export interface ToolCallProvenanceProps {
  /**
   * Canonical namespaced tool name as it appears in the event log,
   * e.g. `ws_helix-collateral__get_doc`. Non-namespaced names (legacy
   * unrouted tools, ambient platform tools) render as-is with no
   * workspace badge.
   */
  toolName: string;
  /** Visual status pill — `ok` is the default. */
  status?: ToolCallProvenanceStatus;
  /**
   * Optional injection point for tests. When omitted, the component
   * pulls the workspace list from `useWorkspaceContext` (the same
   * source of truth the sidebar reads).
   */
  workspaces?: readonly WorkspaceInfo[];
}

export function ToolCallProvenance({
  toolName,
  status = "ok",
  workspaces,
}: ToolCallProvenanceProps) {
  const wsCtx = useWorkspaceContext();
  const list = workspaces ?? wsCtx.workspaces;

  const parsed = parseNamespacedToolName(toolName);
  // Fallback to raw on missing workspace (Q2). Two paths to raw:
  //   1. Input isn't namespaced at all (legacy / unrouted) — render the
  //      raw input verbatim.
  //   2. wsId is well-formed but no longer in the user's list — render
  //      the full raw `ws_<id>-<tool>` so the user can still see what
  //      tool was called and which workspace it came from.
  if (!parsed) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        data-testid="tool-call-provenance"
        data-fallback="non-namespaced"
      >
        <span className="font-mono text-sm">{toolName}</span>
        <StatusPill status={status} />
      </span>
    );
  }

  const friendlyTool = stripServerPrefix(parsed.toolName);
  const scope = parsed.scope;

  // Identity tool (bare `<source>__<tool>`): a personal, cross-workspace
  // surface owned by the user (conversations / files / automations). No
  // workspace badge — it doesn't belong to a workspace.
  if (scope.kind === "identity") {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        data-testid="tool-call-provenance"
        data-scope="identity"
      >
        <span className="font-mono text-sm">{friendlyTool}</span>
        <StatusPill status={status} />
      </span>
    );
  }

  const workspace = list.find((w) => w.id === scope.wsId);

  if (!workspace) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        data-testid="tool-call-provenance"
        data-fallback="missing-workspace"
        data-raw={toolName}
      >
        <span className="font-mono text-sm">{toolName}</span>
        <StatusPill status={status} />
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid="tool-call-provenance"
      data-workspace-id={workspace.id}
    >
      <span className="font-mono text-sm">{friendlyTool}</span>
      <span className="text-muted-foreground">·</span>
      <WorkspaceBadge workspace={workspace} />
      <StatusPill status={status} />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals — workspace badge + status pill
//
// The workspace badge picks a stable visual treatment per workspace id
// so two transcript entries from the same workspace render with the
// same color. The mapping is deterministic (no random palette) and
// matches the sidebar's treatment so the user reads "this badge maps
// to that sidebar row" by sight.
// ─────────────────────────────────────────────────────────────────────────────

const BADGE_VARIANTS = ["default", "secondary", "success", "warning", "processing"] as const;
type BadgeVariant = (typeof BADGE_VARIANTS)[number];

/**
 * Deterministic hash → badge variant. Same workspace id always yields
 * the same variant; collision rate across realistic workspace counts
 * (<20) is acceptable.
 */
export function workspaceBadgeVariant(workspace: WorkspaceInfo): BadgeVariant {
  // Personal workspace gets a fixed treatment so it's instantly
  // recognizable across both sidebar + provenance + composer footer.
  if (workspace.isPersonal === true) return "secondary";
  let h = 0;
  for (let i = 0; i < workspace.id.length; i++) {
    h = (h * 31 + workspace.id.charCodeAt(i)) >>> 0;
  }
  // Skip "secondary" so personal stays distinct.
  const variants = BADGE_VARIANTS.filter((v) => v !== "secondary");
  return variants[h % variants.length] ?? "default";
}

function WorkspaceBadge({ workspace }: { workspace: WorkspaceInfo }) {
  const variant = workspaceBadgeVariant(workspace);
  return (
    <Badge
      variant={variant}
      data-testid="workspace-badge"
      data-workspace-id={workspace.id}
      data-workspace-variant={variant}
    >
      {workspace.name}
    </Badge>
  );
}

const STATUS_LABEL: Record<ToolCallProvenanceStatus, string> = {
  ok: "ok",
  error: "error",
  running: "running",
};

function StatusPill({ status }: { status: ToolCallProvenanceStatus }) {
  const variant: BadgeVariant =
    status === "error" ? "warning" : status === "running" ? "processing" : "success";
  return (
    <Badge
      variant={variant}
      data-testid="status-pill"
      data-status={status}
      // Visual de-emphasis vs. the workspace badge — same chip family,
      // smaller weight.
      className="font-normal"
    >
      {STATUS_LABEL[status]}
    </Badge>
  );
}
