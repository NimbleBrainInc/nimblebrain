import { useMemo, useState } from "react";
import {
  type DirectoryEntry,
  disconnectConnector,
  type InstalledConnector,
  initiateComposioOAuth,
  initiateMcpOAuth,
} from "../../api/client";
import { BundleCredentialsModal } from "./BundleCredentialsModal";
import { ComposioApiKeyModal } from "./ComposioApiKeyModal";
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
 *   - connecting/starting + remote          → Cancel (reset a wedged OAuth)
 *
 * Disconnecting an *established* connection is intentionally NOT here —
 * that destructive affordance lives on the connection details section.
 * The one exception is Cancel on a connector wedged mid-connect: it
 * resets a connection that never completed (no live session to tear
 * down), turning a dead-end "Connecting…" back into an actionable
 * Connect. The hero otherwise carries forward-motion CTAs only.
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
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);

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
      registryId: "bundled-static",
      registryType: "static",
      name: cat.name,
      description: cat.description,
      ...(installed.iconUrl ? { iconUrl: installed.iconUrl } : {}),
      tags: cat.tags,
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
  }, [cat, installed.iconUrl]);

  const action = resolveAction(installed, !!directoryEntry);

  // Connector version, two axes: the running serverInfo.version (handshakeVersion —
  // what's actually connected) takes precedence over the declared catalog/manifest
  // version (installed.version; "remote" is the placeholder for a remote bundle that
  // declares none, not a real version). When both exist and differ, the declared one
  // is surfaced as a small drift note rather than silently hidden.
  const declaredVersion = installed.version !== "remote" ? installed.version : undefined;
  const shownVersion = installed.handshakeVersion ?? declaredVersion;
  const versionDrift =
    installed.handshakeVersion && declaredVersion && installed.handshakeVersion !== declaredVersion
      ? declaredVersion
      : undefined;

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
    if (action.kind === "cancel") {
      // Reset a connector wedged mid-connect. `disconnect` flips the
      // connection back to `not_authenticated` (no established session to
      // revoke — the OAuth dance never finished), so `onChanged`'s refetch
      // re-renders the hero with the normal Connect CTA.
      setActing(true);
      try {
        await disconnectConnector(installed.serverName, installed.scope);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActing(false);
      }
      return;
    }
    if (action.kind === "oauth") {
      // API-key Composio connectors have no redirect — collect the declared
      // fields in a modal and call connect_api_key (rotation is admin-gated
      // server-side). Branch before the OAuth dispatch below.
      if (cat?.auth === "composio" && cat.composio?.authScheme === "API_KEY") {
        setApiKeyModalOpen(true);
        return;
      }
      setActing(true);
      try {
        // Composio-backed connectors route through their own
        // initiate endpoint (Composio holds the tokens; we just
        // persist a connectedAccountId pointer). Native OAuth
        // (dcr + static) still goes through /v1/mcp-auth/initiate.
        const { authorizationUrl } =
          cat?.auth === "composio"
            ? await initiateComposioOAuth(cat.id)
            : await initiateMcpOAuth(installed.serverName);
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
          iconUrl={installed.iconUrl}
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
          {/* Version: running serverInfo.version primary, declared (catalog/manifest)
              version shown only when it drifts from what's running. Covers remote
              connectors (fleet, Composio, OAuth) — which report a handshake version
              but carry no meaningful bundle version — as well as local bundles. */}
          {shownVersion && (
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              v{shownVersion}
              {versionDrift && (
                <span className="ml-2 text-muted-foreground/70">catalog v{versionDrift}</span>
              )}
            </p>
          )}
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
      {apiKeyModalOpen && cat && (
        <ComposioApiKeyModal
          catalogId={cat.id}
          connectorName={name}
          fields={cat.composio?.fields ?? []}
          open={apiKeyModalOpen}
          onClose={() => setApiKeyModalOpen(false)}
          onConnected={() => {
            setApiKeyModalOpen(false);
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
  | { kind: "oauth"; label: string; adminOnly: false }
  | { kind: "cancel"; label: string; adminOnly: false };

/**
 * Map the connector's status to the appropriate primary CTA. The
 * mapping is deliberate: each status has at most one forward-motion
 * action, and the action label uses the user's vocabulary
 * ("Configure", "Connect", "Reconnect") rather than the underlying
 * mechanism ("save credentials", "initiate OAuth flow").
 *
 * Returns null when no CTA applies — `ready` (nothing to do),
 * `connecting` / `starting` on a non-remote bundle (wait it out), or
 * `failed` on a non-remote bundle (admin needs to investigate; no
 * one-click fix). A remote connector that's `connecting` / `starting`
 * gets a Cancel CTA so a wedged OAuth isn't a dead end.
 */
function resolveAction(
  installed: InstalledConnector,
  hasOperatorEntry: boolean,
): PrimaryAction | null {
  const isRemote = installed.type === "remote";

  switch (installed.status) {
    case "ready":
      return null;

    case "connecting":
    case "starting":
      // A remote connector can wedge mid-OAuth — the auth window was
      // closed or the callback never returned, leaving `pending_auth` with
      // a source that never finished starting. Without an escape hatch the
      // page reads "Connecting…" forever. Cancel disconnects (resets to
      // `not_authenticated`), after which the normal Connect CTA reappears.
      // stdio bundles ("starting") have no OAuth to cancel — wait them out.
      return isRemote ? { kind: "cancel", label: "Cancel", adminOnly: false } : null;

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
