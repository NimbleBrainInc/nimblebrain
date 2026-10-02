import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  disconnectConnector,
  type InstalledConnector,
  initiateComposioOAuth,
  initiateMcpOAuth,
} from "../../api/client";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { ComposioApiKeyModal } from "./ComposioApiKeyModal";
import { ConnectorIcon } from "./ConnectorIcon";
import { OperatorSetupModal, type OperatorSetupTarget } from "./OperatorSetupModal";

/**
 * The header of every connector's settings page. One structure for all of them:
 *
 *   [icon] <display name>  ● <status>                                  [⋯]
 *          <description>
 *   [ status banner + primary action — only when something needs doing ]
 *
 * - **Identity and state on one line.** The status badge says what is true now
 *   ("Connected", "Connected as <account>", "Not connected"), so a connection
 *   needs no row of its own.
 * - **Secondary and destructive actions behind ⋯.** Documentation, Disconnect and
 *   Uninstall are rare and, for the last two, costly to click by accident, so they
 *   do not sit on the page. Each of those two confirms in its own dialog.
 * - **Technical detail in the menu's footer**, not under the name: the version,
 *   the tool count and whether the connector has an interface.
 *
 * The status banner is an absorbing element — when a connector is `ready` it
 * hides and the page reads as a quiet settings surface. When attention is
 * required (`needs_setup`, `needs_auth`, `failed`), it appears as the page's
 * first actionable concern. `not_connected` shows the same banner in a neutral
 * tone: nothing is wrong, but Connect is still the one thing to do here.
 *
 * Owns the primary CTA dispatch:
 *   - needs_setup + missing operator OAuth → OperatorSetupModal
 *   - not_connected                         → initiateMcpOAuth (Connect)
 *   - needs_auth                            → initiateMcpOAuth (Reconnect)
 *   - failed                                → initiateMcpOAuth (same as Reconnect)
 *   - connecting/starting                   → Cancel (reset a wedged OAuth)
 *
 * The banner carries forward-motion CTAs only; disconnecting an established
 * connection is in the menu. The one exception is Cancel on a connector wedged
 * mid-connect: it resets a connection that never completed (no live session to
 * tear down), turning a dead-end "Connecting…" back into an actionable Connect.
 */
export function ConnectorHeader({
  installed,
  canManage,
  onChanged,
  onUninstall,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  onChanged: () => void;
  /** Opens the page's uninstall confirmation. Offered to a workspace admin only. */
  onUninstall: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operatorModalOpen, setOperatorModalOpen] = useState(false);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const cat = installed.catalog;
  const name = installed.displayName;

  // The OAuth-app target for OperatorSetupModal, present only for a static-auth
  // entry that declares one. Null is also the "no Set up CTA" signal below.
  const operatorTarget = useMemo<OperatorSetupTarget | null>(() => {
    if (cat?.auth !== "static" || !cat.operatorSetup) return null;
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
   * static) still goes through /v1/workspaces/:wsId/mcp-auth/initiate. On failure the
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
      <IdentityRow
        installed={installed}
        name={name}
        menu={
          <ConnectorMenu
            installed={installed}
            canManage={canManage}
            acting={acting}
            onDisconnect={() => setConfirmingDisconnect(true)}
            onUninstall={onUninstall}
          />
        }
      />

      <StatusBlock
        installed={installed}
        action={action}
        canManage={canManage}
        acting={acting}
        onPrimary={onPrimary}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {canManage && (
        <DisconnectDialog
          installed={installed}
          open={confirmingDisconnect}
          onOpenChange={setConfirmingDisconnect}
          onDisconnected={onChanged}
        />
      )}
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

/** Identity row — icon, display name, status badge and description, with the
 *  connector's menu at the right. Always present; the page's title block. */
function IdentityRow({
  installed,
  name,
  menu,
}: {
  installed: InstalledConnector;
  name: string;
  menu: ReactNode;
}) {
  return (
    // Centred on the icon: with or without a description, the name sits level with it.
    <div className="flex items-center gap-4">
      {/* The icon falls back to a letter avatar with a deterministic tint
          when no iconUrl is set (or the URL 404s — Asana's vendor link does
          without auth), matching the Browse cards' treatment. */}
      <ConnectorIcon
        name={name}
        iconUrl={installed.iconUrl}
        className="h-12 w-12 rounded-sm text-base"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
          <StatusBadge installed={installed} />
        </div>
        {installed.catalog?.description && (
          <p className="text-sm text-muted-foreground mt-1">{installed.catalog.description}</p>
        )}
      </div>
      <div className="shrink-0">{menu}</div>
    </div>
  );
}

/** What is true of the connection now, beside the name. "Connected as <account>"
 *  when the connector reports whose account it acts as. */
function StatusBadge({ installed }: { installed: InstalledConnector }) {
  const account = installed.identity?.email ?? installed.identity?.name;
  const label =
    installed.status === "ready"
      ? account
        ? `Connected as ${account}`
        : "Connected"
      : statusLabel(installed.status);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot status={installed.status} className="" />
      {label}
    </span>
  );
}

/**
 * Disconnect asks first, and says what it leaves: the connection is shared, so it
 * goes for everyone, while the install, its tool permissions and its settings stay,
 * and Uninstall is what removes them. Without that, a disconnected connector reads
 * as something to clean up rather than a connector at rest. A failure stays in the
 * dialog with its error.
 */
export function DisconnectDialog({
  installed,
  open,
  onOpenChange,
  onDisconnected,
}: {
  installed: InstalledConnector;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}) {
  const name = installed.displayName;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Disconnect ${name}?`}
      description="Disconnects it for everyone in this workspace. Its tools stop working in chats and automations until someone connects it again."
      confirmLabel="Disconnect"
      pendingLabel="Disconnecting…"
      onConfirm={async () => {
        await disconnectConnector(installed.serverName, installed.scope);
        onOpenChange(false);
        onDisconnected();
      }}
    >
      <p className="text-muted-foreground">
        {name} stays installed, with its tool permissions and settings. To remove it, use Uninstall.
      </p>
    </ConfirmDialog>
  );
}

/** One entry in the connector's ⋯ menu, in order. */
export type ConnectorMenuItem =
  | { kind: "docs"; href: string }
  | { kind: "disconnect" }
  | { kind: "uninstall" }
  | { kind: "details"; text: string };

/**
 * What the ⋯ menu offers, decided here and only rendered by the component.
 * A member gets the documentation link and the details; a workspace admin also
 * gets Disconnect — only for an established connection whose credential a person
 * authorized (`disconnectable`); a fleet connector has none — and Uninstall.
 */
export function connectorMenuItems(
  installed: InstalledConnector,
  canManage: boolean,
): ConnectorMenuItem[] {
  const items: ConnectorMenuItem[] = [];
  const docsUrl = installed.catalog?.docsUrl;
  if (docsUrl) items.push({ kind: "docs", href: docsUrl });
  if (canManage && installed.disconnectable && installed.state === "running") {
    items.push({ kind: "disconnect" });
  }
  if (canManage) items.push({ kind: "uninstall" });
  const details = connectorDetails(installed);
  if (details) items.push({ kind: "details", text: details });
  return items;
}

/** The connector's ⋯ menu: renders `connectorMenuItems`, with a rule before the
 *  destructive item and before the details. */
function ConnectorMenu({
  installed,
  canManage,
  acting,
  onDisconnect,
  onUninstall,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  acting: boolean;
  onDisconnect: () => void;
  onUninstall: () => void;
}) {
  const items = connectorMenuItems(installed, canManage);
  if (items.length === 0) return null;
  const itemClass =
    "flex w-full cursor-default items-center px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/10 data-[disabled]:opacity-50";
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`${installed.displayName} options`}
        className="rounded-sm p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[popup-open]:bg-foreground/10"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-52 rounded-sm border bg-popover py-1 text-popover-foreground shadow-md outline-none">
            {items.flatMap((item, i) => {
              // A rule separates the destructive item, and the details, from what precedes them.
              const rule =
                i > 0 && (item.kind === "uninstall" || item.kind === "details")
                  ? [
                      <Menu.Separator
                        key={`rule-${item.kind}`}
                        className="my-1 h-px bg-border/60"
                      />,
                    ]
                  : [];
              return [
                ...rule,
                renderMenuItem(item, { itemClass, acting, onDisconnect, onUninstall }),
              ];
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** One menu entry, by kind. */
function renderMenuItem(
  item: ConnectorMenuItem,
  handlers: {
    itemClass: string;
    acting: boolean;
    onDisconnect: () => void;
    onUninstall: () => void;
  },
): ReactNode {
  const { itemClass, acting, onDisconnect, onUninstall } = handlers;
  switch (item.kind) {
    case "docs":
      return (
        <Menu.LinkItem
          key="docs"
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className={itemClass}
        >
          Documentation ↗
        </Menu.LinkItem>
      );
    case "disconnect":
      return (
        <Menu.Item key="disconnect" className={itemClass} disabled={acting} onClick={onDisconnect}>
          Disconnect
        </Menu.Item>
      );
    case "uninstall":
      return (
        <Menu.Item
          key="uninstall"
          className={`${itemClass} text-destructive`}
          onClick={onUninstall}
        >
          Uninstall…
        </Menu.Item>
      );
    case "details":
      // A disabled item, not a paragraph: arrow keys reach it and a screen reader reads it.
      return (
        <Menu.Item
          key="details"
          disabled
          className="cursor-default px-3 py-1.5 text-2xs text-muted-foreground outline-none data-[highlighted]:bg-foreground/5"
        >
          {item.text}
        </Menu.Item>
      );
  }
}

/**
 * "v4.0.10 · 27 tools · Interactive", for the menu's footer. The version is the
 * running server's (serverInfo.version) when it reports one, else the declared
 * one, and the declared one follows as "catalog vX" when the two differ. The
 * placeholder sentinels "remote" and "unknown" are not versions and are left out.
 * A version number gets one leading "v"; a build SHA is shown as-is.
 */
export function connectorDetails(installed: InstalledConnector): string {
  const asVersion = (v: string | undefined) =>
    v && v !== "remote" && v !== "unknown" ? v : undefined;
  const running = asVersion(installed.handshakeVersion);
  const declared = asVersion(installed.version);
  const version = running ?? declared;
  const vlabel = (v: string) => {
    const bare = v.replace(/^v/, "");
    return /^\d+\.\d+/.test(bare) ? `v${bare}` : bare;
  };
  const drift = running && declared && vlabel(running) !== vlabel(declared) ? declared : undefined;
  return [
    version ? vlabel(version) : undefined,
    drift ? `catalog ${vlabel(drift)}` : undefined,
    installed.toolCount > 0
      ? `${installed.toolCount} ${installed.toolCount === 1 ? "tool" : "tools"}`
      : undefined,
    installed.interactive ? "Interactive" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
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
function StatusDot({
  status,
  className = "mt-1.5",
}: {
  status: InstalledConnector["status"];
  className?: string;
}) {
  const cls: Record<InstalledConnector["status"], string> = {
    ready: "bg-emerald-500",
    needs_setup: "bg-amber-500",
    // At rest, not a warning: never connected, or disconnected on purpose.
    not_connected: "bg-muted-foreground/50",
    needs_auth: "bg-amber-500",
    // Pulse on connecting/starting is the one motion exception — it
    // signals "in-flight, do not retry yet" and disappears as soon
    // as the state resolves. Silent CSS, no JS animation library.
    connecting: "bg-blue-500 animate-pulse",
    starting: "bg-blue-500 animate-pulse",
    failed: "bg-rose-500",
  };
  return (
    <span className={`${className} h-2 w-2 rounded-full ${cls[status]} shrink-0`} aria-hidden />
  );
}

/** One short phrase per status. Reads as "what's true right now,"
 *  not "what to do" — the action label carries the verb. */
export function statusLabel(status: InstalledConnector["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "needs_setup":
      return "Configuration required";
    case "not_connected":
      return "Not connected";
    case "needs_auth":
      return "Reconnection needed";
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
  // to the workspace's `composio-auth/initiate` for a composio entry and its
  // `mcp-auth/initiate` otherwise (which hardcodes
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

    // First-time auth vs re-auth: same flow, different verb. The user has
    // stronger context if we tell them which.
    case "not_connected":
      return { kind: "oauth", label: "Connect", adminOnly: authRotatesSharedCredential };

    case "needs_auth":
      return { kind: "oauth", label: "Reconnect", adminOnly: authRotatesSharedCredential };

    case "failed":
      // Reconnect is usually the fix (token upstream rejected, transport
      // blip).
      return { kind: "oauth", label: "Reconnect", adminOnly: authRotatesSharedCredential };
  }
}
