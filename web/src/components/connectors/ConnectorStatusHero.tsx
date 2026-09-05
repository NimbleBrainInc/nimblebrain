import { useMemo, useState } from "react";
import {
  disconnectConnector,
  type InstalledConnector,
  initiateComposioOAuth,
  initiateMcpOAuth,
} from "../../api/client";
import { Button } from "../ui/button";
import { ComposioApiKeyModal } from "./ComposioApiKeyModal";
import { ConnectorIcon } from "./ConnectorIcon";
import { OperatorSetupModal, type OperatorSetupTarget } from "./OperatorSetupModal";

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
 *   - needs_auth (any cause)                → initiateMcpOAuth
 *   - failed                                → initiateMcpOAuth (same as Reconnect)
 *   - connecting/starting                   → Cancel (reset a wedged OAuth)
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
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);

  const cat = installed.catalog;
  const name = cat?.name ?? installed.serverName;

  // The OAuth-app target for OperatorSetupModal, present only for a static-auth
  // entry that declares one. Null is also the "no Set up CTA" signal below.
  const operatorTarget = useMemo<OperatorSetupTarget | null>(() => {
    if (!cat || cat.auth !== "static" || !cat.operatorSetup) return null;
    return { id: cat.id, name: cat.name, operatorSetup: cat.operatorSetup };
  }, [cat]);

  // A composio API-key connector has no redirect: its auth CTA opens the key
  // modal and calls `connect_api_key`, which admin-gates once a connected
  // account exists. Reconnect/failed are exactly that case. This is the one
  // auth path the server *does* gate, which is why it is the one gated here.
  //
  // Unlike `canWriteWorkspace`, this is a *proxy*, not a term-for-term mirror:
  // the server's condition is `prior?.connectedAccountId` existing, which the
  // client can't see, so it stands in reauth_required/failed. The divergence
  // is fail-closed — a never-connected connector that reached `failed` gates a
  // member who could have done a first connect. Annoying, not unsafe.
  //
  // Falls to `false` when `catalog` is absent (it is optional on
  // `InstalledConnector`), leaving the same ungated behaviour as a native
  // flow — no worse than the gap above, and it resolves with it.
  const authRotatesSharedCredential =
    cat?.auth === "composio" &&
    cat.composio?.authScheme === "API_KEY" &&
    (installed.state === "reauth_required" || installed.status === "failed");
  const action = resolveAction(installed, !!operatorTarget, authRotatesSharedCredential);

  /** Surface an unknown error's message on the hero. */
  const reportError = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  /**
   * Reset a connector wedged mid-connect. `disconnect` flips the
   * connection back to `not_authenticated` (no established session to
   * revoke — the OAuth dance never finished), so `onChanged`'s refetch
   * re-renders the hero with the normal Connect CTA.
   */
  const cancelConnect = async () => {
    setActing(true);
    try {
      await disconnectConnector(installed.serverName, installed.scope);
      onChanged();
    } catch (err) {
      reportError(err);
    } finally {
      setActing(false);
    }
  };

  /**
   * Kick off the OAuth redirect. Composio-backed connectors route
   * through their own initiate endpoint (Composio holds the tokens; we
   * just persist a connectedAccountId pointer). Native OAuth (dcr +
   * static) still goes through /v1/mcp-auth/initiate. On failure the
   * button resets so the user can retry.
   */
  const runOAuth = async () => {
    setActing(true);
    try {
      const { authorizationUrl } =
        cat?.auth === "composio"
          ? await initiateComposioOAuth(cat.id)
          : await initiateMcpOAuth(installed.serverName);
      if (!authorizationUrl) {
        // Provider-minted / already-authenticated: the source reconnected without
        // an interactive flow — refresh status in place instead of redirecting to a
        // nonexistent auth page (#679).
        onChanged();
        setActing(false);
        return;
      }
      window.location.assign(authorizationUrl);
    } catch (err) {
      reportError(err);
      setActing(false);
    }
  };

  const onPrimary = async () => {
    if (!action) return;
    setError(null);
    switch (action.kind) {
      case "open-operator-modal":
        setOperatorModalOpen(true);
        return;
      case "cancel":
        await cancelConnect();
        return;
      case "oauth":
        // API-key Composio connectors have no redirect — collect the
        // declared fields in a modal and call connect_api_key (rotation
        // is admin-gated server-side). Branch before the OAuth dispatch.
        if (cat?.auth === "composio" && cat.composio?.authScheme === "API_KEY") {
          setApiKeyModalOpen(true);
          return;
        }
        await runOAuth();
        return;
    }
  };

  return (
    <section className="space-y-5">
      <IdentityRow installed={installed} name={name} />

      <StatusBlock
        installed={installed}
        action={action}
        canManage={canManage}
        acting={acting}
        onPrimary={onPrimary}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {operatorModalOpen && operatorTarget && (
        <OperatorSetupModal
          entry={operatorTarget}
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

// ── Hero sections ───────────────────────────────────────────────────

/** Identity row — icon + name + interactive badge + version + description.
 *  Always present; the page's title block. */
function IdentityRow({ installed, name }: { installed: InstalledConnector; name: string }) {
  const cat = installed.catalog;

  // Connector version, two axes: the running serverInfo.version (handshakeVersion —
  // what's actually connected) takes precedence over the declared catalog/manifest
  // version (installed.version). Either can arrive as a placeholder sentinel — "remote"
  // for a remote bundle that declares none, "unknown" when it isn't known — which are
  // not versions and never render. When both are real and differ, the declared one is
  // surfaced as a small drift note rather than silently hidden.
  const asVersion = (v: string | undefined) =>
    v && v !== "remote" && v !== "unknown" ? v : undefined;
  // Display form: exactly one leading "v", but only for a version NUMBER. Image tags
  // carry it (v0.1.0) and catalog manifests may not (0.1.0), so normalize both to a
  // single "v". A build SHA (edge channel, e.g. cd0ab7f) or other non-semver
  // identifier is shown as-is; the "v" convention is semver's, not a commit's.
  const vlabel = (v: string) => {
    const bare = v.replace(/^v/, "");
    return /^\d+\.\d+/.test(bare) ? `v${bare}` : bare;
  };

  const declaredVersion = asVersion(installed.version);
  const runningVersion = asVersion(installed.handshakeVersion);
  const shownVersion = runningVersion ?? declaredVersion;
  const versionDrift =
    runningVersion && declaredVersion && vlabel(runningVersion) !== vlabel(declaredVersion)
      ? declaredVersion
      : undefined;

  return (
    <div className="flex items-start gap-4">
      {/* The icon falls back to a letter avatar with a deterministic tint
          when no iconUrl is set (or the URL 404s — Asana's vendor link does
          without auth), matching the Browse cards' treatment. */}
      <ConnectorIcon
        name={name}
        iconUrl={installed.iconUrl}
        className="h-12 w-12 rounded-sm text-base"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
          {installed.interactive && (
            <span className="text-3xs px-1.5 py-0.5 rounded bg-accent/50 text-accent-foreground font-medium">
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
            {vlabel(shownVersion)}
            {versionDrift && <span className="ml-2">catalog {vlabel(versionDrift)}</span>}
          </p>
        )}
        {cat?.description && (
          <p className="text-sm text-muted-foreground mt-1">{cat.description}</p>
        )}
      </div>
    </div>
  );
}

/** Status block — the page's actionable anchor when the connector needs
 *  attention. Renders nothing while `ready` (the page reads as quiet
 *  settings); any other status makes this the visual anchor with the CTA. */
function StatusBlock({
  installed,
  action,
  canManage,
  acting,
  onPrimary,
}: {
  installed: InstalledConnector;
  action: PrimaryAction | null;
  canManage: boolean;
  acting: boolean;
  onPrimary: () => void;
}) {
  if (installed.status === "ready") return null;

  // The span and the button are the two arms of one decision, so they read a
  // single value. Admin-gated actions are withheld from a non-admin; the rest
  // stay, because the server permits them (see the `oauth` note above).
  const blocked = !!action?.adminOnly && !canManage;

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 border border-border/60 rounded-sm bg-muted/20">
      <div className="flex items-start gap-3 min-w-0">
        <StatusDot status={installed.status} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{statusLabel(installed.status)}</div>
          {installed.statusReason && (
            <div className="text-xs text-muted-foreground mt-0.5">{installed.statusReason}</div>
          )}
        </div>
      </div>
      {/* A suppressed CTA leaves a member with a pulsing dot and no
       * explanation — worse than the refusal they used to click into. Say
       * why, matching the "Workspace admin required" copy the browse page
       * shows in the same situation. */}
      {blocked && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {action?.kind === "open-operator-modal"
            ? "Operator setup required"
            : "Workspace admin required"}
        </span>
      )}
      {action && !blocked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onPrimary}
          disabled={acting}
        >
          {acting ? "Working…" : action.label}
        </Button>
      )}
    </div>
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
  | { kind: "open-operator-modal"; label: string; adminOnly: true }
  // `oauth` is admin-only when it rotates a shared credential and ungated
  // otherwise — conditional rather than fixed by kind.
  //
  // "Ungated otherwise" tracks the server, not a claim that the flow is
  // per-caller. It isn't: the auth CTA binds the *workspace's* shared
  // credential to whoever ran it, via one of two routes — `runOAuth` dispatches
  // to `/v1/composio-auth/initiate` for a composio entry and
  // `/v1/mcp-auth/initiate` otherwise (which hardcodes
  // `WORKSPACE_PRINCIPAL_ID`). **Both** carry `requireAuth` + `requireWorkspace`
  // only, with no admin check, so gating here would hide a capability the
  // server grants.
  //
  // The gap is server-side and filed (#755). Note `authScheme` is optional and
  // defaults to OAUTH2, so a composio connector usually takes the composio
  // route and is *not* covered by the API_KEY predicate below. Gating only one
  // route and flipping this to `adminOnly: true` would therefore re-create the
  // client/server disagreement this file exists to remove — the conditional
  // collapses when **both** routes are gated, not one.
  | { kind: "oauth"; label: string; adminOnly: boolean }
  | { kind: "cancel"; label: string; adminOnly: true };

/**
 * Map the connector's status to the appropriate primary CTA. The
 * mapping is deliberate: each status has at most one forward-motion
 * action, and the action label uses the user's vocabulary
 * ("Configure", "Connect", "Reconnect") rather than the underlying
 * mechanism ("save credentials", "initiate OAuth flow").
 *
 * Returns null when no CTA applies — `ready` (nothing to do), or
 * `needs_setup` with no operator catalog entry to configure. A connector
 * that's `connecting` / `starting` gets a Cancel CTA so a wedged OAuth
 * isn't a dead end.
 */
function resolveAction(
  installed: InstalledConnector,
  hasOperatorEntry: boolean,
  /** True when the auth CTA rotates a credential the server admin-gates —
   *  `handleConnectApiKey`, once a connected account exists. See the `oauth`
   *  note on `PrimaryAction` for why the other auth paths stay ungated. */
  authRotatesSharedCredential: boolean,
): PrimaryAction | null {
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
      //
      // Admin-only: cancelling calls `disconnectConnector`, and `handleDisconnect`
      // refuses a non-admin outright ("Workspace admin role required to disconnect
      // shared connectors"). The OAuth runs as `WORKSPACE_PRINCIPAL_ID`, so there
      // is no per-member session for a member to cancel — the server is right to
      // refuse, and offering the button only wedges them with a red error.
      return { kind: "cancel", label: "Cancel", adminOnly: true };

    case "needs_setup": {
      // The only setup gate left: a static-auth catalog match without a
      // configured operator OAuth client can't proceed until an admin
      // registers one.
      if (installed.missingOperatorSetup && hasOperatorEntry) {
        return { kind: "open-operator-modal", label: "Set up OAuth", adminOnly: true };
      }
      return null;
    }

    case "needs_auth": {
      // First-time auth vs re-auth: same flow, different verb. The
      // user has stronger context if we tell them which.
      const verb = installed.state === "reauth_required" ? "Reconnect" : "Connect";
      return { kind: "oauth", label: verb, adminOnly: authRotatesSharedCredential };
    }

    case "failed":
      // Reconnect is usually the fix (token upstream rejected, transport
      // blip).
      return { kind: "oauth", label: "Reconnect", adminOnly: authRotatesSharedCredential };
  }
}
