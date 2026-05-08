import { useMemo, useState } from "react";
import { type DirectoryEntry, initiateMcpOAuth, type InstalledConnector } from "../../api/client";
import { BundleCredentialsModal } from "./BundleCredentialsModal";
import { ConnectorIcon } from "./ConnectorIcon";
import { OperatorSetupModal } from "./OperatorSetupModal";

/**
 * Hero block for the Connector Configure page. Carries the visual
 * weight of the page: status indicator + connector identity + the
 * primary call-to-action derived from `installed.status`.
 *
 * The status block is an absorbing element — when a connector is
 * `ready`, the whole status row hides and the page reads as a quiet
 * settings surface. When attention is required (`needs_setup`,
 * `needs_auth`, `failed`), the status row appears as the page's first
 * actionable concern, ahead of the secondary sections that show
 * connection details / OAuth client audit / bundle config.
 *
 * Owns the primary CTA dispatch:
 *   - needs_setup + missing operator OAuth → OperatorSetupModal
 *   - needs_setup + unpopulated user_config → BundleCredentialsModal
 *   - needs_auth (any cause)                → initiateMcpOAuth
 *   - failed + remote OAuth                 → initiateMcpOAuth (same as Reconnect)
 *
 * Disconnect is intentionally NOT here — it's a destructive
 * affordance that lives on the connection details section. The hero
 * only carries forward-motion CTAs.
 */
export function ConnectorStatusHero({
  installed,
  canManage,
  onChanged,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundleModalOpen, setBundleModalOpen] = useState(false);
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);

  const cat = installed.catalog;
  const name = cat?.name ?? installed.serverName;

  // Synthesize a DirectoryEntry shape for OperatorSetupModal — it only
  // reads `id`, `name`, and `install.operatorSetup`. Same trick
  // OperatorOAuthSection uses; could be extracted but the call is
  // small enough that duplication beats premature abstraction.
  const directoryEntry = useMemo<DirectoryEntry | null>(() => {
    if (!cat || cat.auth !== "static" || !cat.operatorSetup) return null;
    return {
      id: cat.id,
      registryId: "curated",
      registryType: "curated",
      name: cat.name,
      description: cat.description,
      iconUrl: cat.iconUrl,
      tags: cat.tags,
      defaultScope: cat.defaultScope,
      install: {
        kind: "remote-oauth",
        url: cat.url,
        auth: "static",
        operatorSetup: cat.operatorSetup,
        ...(cat.requiredScopes ? { requiredScopes: cat.requiredScopes } : {}),
        ...(cat.additionalAuthorizationParams
          ? { additionalAuthorizationParams: cat.additionalAuthorizationParams }
          : {}),
      },
    };
  }, [cat]);

  const action = resolveAction(installed, !!directoryEntry);

  const onPrimary = async () => {
    if (!action) return;
    setError(null);
    if (action.kind === "open-bundle-modal") {
      setBundleModalOpen(true);
      return;
    }
    if (action.kind === "open-operator-modal") {
      setOperatorModalOpen(true);
      return;
    }
    if (action.kind === "oauth") {
      setActing(true);
      try {
        const { authorizationUrl } = await initiateMcpOAuth(installed.serverName);
        window.location.assign(authorizationUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setActing(false);
      }
    }
  };

  return (
    <section className="space-y-5">
      {/* Identity row — icon + name + description. Always present;
          the page's title block. The icon falls back to a letter
          avatar with a deterministic tint when no iconUrl is set
          (or the URL 404s — Asana's vendor link does without auth),
          matching the Browse cards' treatment. */}
      <div className="flex items-start gap-4">
        <ConnectorIcon
          name={name}
          iconUrl={cat?.iconUrl}
          className="h-12 w-12 rounded-md text-base"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
            {installed.interactive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/40 text-accent-foreground font-medium">
                Interactive
              </span>
            )}
          </div>
          {cat?.description && (
            <p className="text-sm text-muted-foreground mt-1">{cat.description}</p>
          )}
        </div>
      </div>

      {/* Status block — only when the connector needs attention.
          When `ready`, the page reads as quiet settings; when any
          other status applies, this block is the visual anchor. */}
      {installed.status !== "ready" && (
        <div className="flex items-start justify-between gap-4 px-4 py-3 border border-border/60 rounded-md bg-muted/30">
          <div className="flex items-start gap-3 min-w-0">
            <StatusDot status={installed.status} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{statusLabel(installed.status)}</div>
              {installed.statusReason && (
                <div className="text-xs text-muted-foreground mt-0.5">{installed.statusReason}</div>
              )}
            </div>
          </div>
          {action && canManageAction(action, canManage) && (
            <button
              type="button"
              onClick={onPrimary}
              disabled={acting}
              className="text-xs px-3 py-1.5 rounded border border-border bg-background hover:bg-muted disabled:opacity-60 shrink-0"
            >
              {acting ? "Working…" : action.label}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {bundleModalOpen && (
        <BundleCredentialsModal
          installed={installed}
          open={bundleModalOpen}
          onClose={() => setBundleModalOpen(false)}
          onSaved={() => {
            setBundleModalOpen(false);
            onChanged();
          }}
        />
      )}
      {operatorModalOpen && directoryEntry && (
        <OperatorSetupModal
          entry={directoryEntry}
          open={operatorModalOpen}
          onClose={() => setOperatorModalOpen(false)}
          onSaved={() => {
            setOperatorModalOpen(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

// ── Status presentation ─────────────────────────────────────────────

/** Colored dot + optional pulse. Sits on the leading edge of the
 *  status block — small enough to recede when the user has read the
 *  label, distinctive enough to scan. */
function StatusDot({ status }: { status: InstalledConnector["status"] }) {
  const cls: Record<InstalledConnector["status"], string> = {
    ready: "bg-emerald-500",
    needs_setup: "bg-amber-500",
    needs_auth: "bg-amber-500",
    // Pulse on connecting/starting is the one motion exception — it
    // signals "in-flight, do not retry yet" and disappears as soon
    // as the state resolves. Silent CSS, no JS animation library.
    connecting: "bg-blue-500 animate-pulse",
    starting: "bg-blue-500 animate-pulse",
    failed: "bg-rose-500",
  };
  return <span className={`mt-1.5 h-2 w-2 rounded-full ${cls[status]} shrink-0`} aria-hidden />;
}

/** One short phrase per status. Reads as "what's true right now,"
 *  not "what to do" — the action label carries the verb. */
function statusLabel(status: InstalledConnector["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs_setup":
      return "Configuration required";
    case "needs_auth":
      return "Sign-in required";
    case "connecting":
      return "Connecting…";
    case "starting":
      return "Starting…";
    case "failed":
      return "Failed";
  }
}

// ── Primary CTA resolution ──────────────────────────────────────────

type PrimaryAction =
  | { kind: "open-bundle-modal"; label: string; adminOnly: true }
  | { kind: "open-operator-modal"; label: string; adminOnly: true }
  | { kind: "oauth"; label: string; adminOnly: false };

/**
 * Map the connector's status to the appropriate primary CTA. The
 * mapping is deliberate: each status has at most one forward-motion
 * action, and the action label uses the user's vocabulary
 * ("Configure", "Connect", "Reconnect") rather than the underlying
 * mechanism ("save credentials", "initiate OAuth flow").
 *
 * Returns null when no CTA applies — `ready` (nothing to do),
 * `connecting` / `starting` (wait), or `failed` on a non-remote
 * bundle (admin needs to investigate; no one-click fix).
 */
function resolveAction(
  installed: InstalledConnector,
  hasOperatorEntry: boolean,
): PrimaryAction | null {
  const isRemote = installed.type === "remote";

  switch (installed.status) {
    case "ready":
    case "connecting":
    case "starting":
      return null;

    case "needs_setup": {
      // Operator OAuth missing comes first: a static-auth catalog
      // match without a configured client can't proceed via the
      // bundle credential modal.
      if (installed.missingOperatorSetup && hasOperatorEntry) {
        return { kind: "open-operator-modal", label: "Set up OAuth", adminOnly: true };
      }
      // Otherwise it's user_config — the only other admin-config
      // gate that surfaces as needs_setup.
      if (installed.userConfig && Object.keys(installed.userConfig.schema).length > 0) {
        return { kind: "open-bundle-modal", label: "Configure", adminOnly: true };
      }
      return null;
    }

    case "needs_auth": {
      // First-time auth vs re-auth: same flow, different verb. The
      // user has stronger context if we tell them which.
      const verb = installed.state === "reauth_required" ? "Reconnect" : "Connect";
      return { kind: "oauth", label: verb, adminOnly: false };
    }

    case "failed":
      // Failed remote bundle → Reconnect is usually the fix (token
      // upstream rejected, transport blip). Failed local bundle →
      // statusReason is shown but no one-click action; the admin
      // diagnoses via the chat agent or logs.
      return isRemote ? { kind: "oauth", label: "Reconnect", adminOnly: false } : null;
  }
}

/** Admin-gated affordances disappear for non-admin members.
 *  Workspace-member-actionable affordances (OAuth flows for the
 *  caller's own account) stay visible. */
function canManageAction(action: PrimaryAction, canManage: boolean): boolean {
  if (action.adminOnly && !canManage) return false;
  return true;
}
