import { useState } from "react";
import type { Plugin } from "../../_generated/platform-schemas/plugins";
import {
  initiateComposioIdentityConnect,
  initiateIdentityConnect,
  type PersonalConnector,
} from "../../api/client";
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
 * `returnConversationId` is the caller's conversation there to reopen on return
 * (the in-chat request card).
 */
export async function personalConnectUrl(
  target: {
    auth: "dcr" | "composio";
    serverName: string;
    connectorId?: string;
  },
  returnWorkspaceId?: string,
  returnConversationId?: string,
): Promise<string | null> {
  // The conversation is sent only when there is one, so a Connect outside the
  // chat makes the same call it always has.
  const back = returnConversationId
    ? ([returnWorkspaceId, returnConversationId] as const)
    : ([returnWorkspaceId] as const);
  const { authorizationUrl } =
    target.auth === "composio" && target.connectorId
      ? await initiateComposioIdentityConnect(target.connectorId, ...back)
      : await initiateIdentityConnect(target.serverName, ...back);
  return authorizationUrl ?? null;
}

/**
 * Where a sign-in started in a workspace comes back to: that workspace's
 * Plugins page, and with `conversationId` the chat reopened on that
 * conversation (the server checks both belong to the caller).
 */
export interface SignInReturn {
  workspaceId: string;
  conversationId?: string;
}

/**
 * Start the sign-in for each of a person's plugin's servers that is not
 * connected, returning to `back` when it finishes.
 *
 * The route follows each connector's record (`connectors`, from
 * `listPersonalConnectors`): the caller has it loaded before calling, so the
 * route is never guessed. The first server that needs the browser sends it
 * there (`go`) and answers `redirected`; when every one connected without an
 * interactive flow, it answers `connected`. A plugin's servers are signed in
 * one at a time, since the browser can follow one sign-in.
 */
export async function startPluginSignIn(
  plugin: Plugin,
  connectors: readonly PersonalConnector[],
  back: SignInReturn,
  go: (url: string) => void = (url) => window.location.assign(url),
): Promise<"redirected" | "connected"> {
  for (const server of plugin.servers) {
    if (server.status === "ready") continue;
    const connector = connectors.find((c) => c.serverName === server.serverName);
    if (!connector) throw new Error(`${plugin.displayName} is not one of your connectors.`);
    const url = await personalConnectUrl(connector, back.workspaceId, back.conversationId);
    if (url) {
      go(url);
      return "redirected";
    }
  }
  return "connected";
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
