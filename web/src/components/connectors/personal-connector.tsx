import { useState } from "react";
import { initiateComposioIdentityConnect, initiateIdentityConnect } from "../../api/client";
import { ToolPermissionsTable } from "./ToolPermissionsTable";

/**
 * The parts of a personal connector's page that Profile → Connectors and a
 * personal plugin's page both show: its Connect route, its tool permissions,
 * and what Disconnect says it does.
 */

/**
 * The authorization URL to send the browser to for a personal connector's
 * Connect, or null when it connected without an interactive flow. The route
 * depends on the auth: composio keys on the catalog connector id, DCR on the
 * serverName. `returnWorkspaceId` is the workspace the Connect is pressed in, so
 * the sign-in returns to its Plugins page; omit it on the profile.
 */
export async function personalConnectUrl(
  target: {
    auth: "dcr" | "composio";
    serverName: string;
    connectorId?: string;
  },
  returnWorkspaceId?: string,
): Promise<string | null> {
  const { authorizationUrl } =
    target.auth === "composio" && target.connectorId
      ? await initiateComposioIdentityConnect(target.connectorId, returnWorkspaceId)
      : await initiateIdentityConnect(target.serverName, returnWorkspaceId);
  return authorizationUrl ?? null;
}

/** What Disconnect does, for its confirm: it also ends every grant. */
export function disconnectConsequence(grants: number): string {
  const base = "Signs out and removes it from your account.";
  if (grants === 0) return base;
  return `${base} It turns off in the ${grants} workspace${grants === 1 ? "" : "s"} it is on in.`;
}

/** A section heading for a personal connector's parts, styled like the tool table's own. */
export function PanelHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * The connector's tool policy — the viewer's own (`scope: "identity"`), so they
 * may always change it. Listing tools starts a cold connector, so the table
 * mounts only when asked for, and replaces this stand-in heading in place.
 */
export function PersonalToolPermissionsSection({
  serverName,
  name,
  connected,
}: {
  serverName: string;
  name: string;
  connected: boolean;
}) {
  const [showing, setShowing] = useState(false);
  if (connected && showing) {
    return <ToolPermissionsTable serverName={serverName} scope="identity" canManage />;
  }
  return (
    <section className="flex items-start justify-between gap-3">
      <PanelHeading
        title="Tool permissions"
        hint={
          connected ? "Choose which tools the agent can call." : `Connect ${name} to see its tools.`
        }
      />
      {connected ? (
        <button
          type="button"
          onClick={() => setShowing(true)}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Show tools
        </button>
      ) : null}
    </section>
  );
}
