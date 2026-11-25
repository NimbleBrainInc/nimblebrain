import { webOrigin } from "../../oauth/public-origin.ts";
import { ConversationNotFoundError } from "../../runtime/errors.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import { workspaceUrl } from "../../workspace/workspace-url.ts";
import { apiError } from "../types.ts";
import { isAddressedWorkspaceMember } from "../workspace-address.ts";

/**
 * Where a connector's OAuth sign-in returns the browser: the Plugins page of the
 * workspace it started in, or the profile's connectors for a personal sign-in
 * started there. Every callback that brings the user back — mcp-auth,
 * composio-auth, and the composio "reuse existing connection" short-circuit —
 * routes through here so they cannot drift onto different pages.
 *
 * `returnWsId` comes from the flow the authenticated initiate registered, never
 * from the callback's request: a workspace connector's own workspace, or the
 * workspace a personal sign-in was started from, checked for membership then.
 * The base is `webOrigin()`, config-derived and validated to be a bare `http(s)`
 * origin, so the redirect can never point off this deployment or carry a
 * `javascript:` / `data:` scheme.
 */
export function connectorReturnUrl(
  returnWsId: string | undefined,
  connected?: ReturnedConnection,
  returnConversationId?: string,
): string {
  const url = returnWsId
    ? workspaceUrl(returnWsId, "/plugins")
    : `${webOrigin()}/profile/connectors`;
  return withConnected(url, connected, returnWsId ? returnConversationId : undefined);
}

/**
 * The connector a callback just connected: its server name, and whose it is.
 * A workspace and a person can each install a connector under the same server
 * name, and both show on a workspace's Plugins page, so the name alone does not
 * say which one the sign-in connected.
 */
export interface ReturnedConnection {
  serverName: string;
  owner: "workspace" | "person";
}

/**
 * Name the connector a callback just connected, as
 * `?connected=<server name>&owner=<workspace|person>`. The page reads it and,
 * once that connector settles, says whether it connected, so the callback
 * renders no page of its own. A connector the page does not list announces
 * nothing. `chat=<conversation id>` reopens the chat panel on the conversation
 * the sign-in was started from.
 */
function withConnected(
  url: string,
  connected: ReturnedConnection | undefined,
  conversationId: string | undefined,
): string {
  const query = new URLSearchParams();
  if (connected) {
    query.set("connected", connected.serverName);
    query.set("owner", connected.owner);
  }
  if (conversationId) query.set("chat", conversationId);
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Read a personal initiate's optional `returnWorkspaceId`: the workspace whose
 * Plugins page the sign-in was started from. Absent means the profile. A value
 * the caller is not a member of (or that names no workspace) is refused with the
 * same 404 a workspace route gives, so the callback can only ever return to a
 * workspace this person reaches.
 */
async function resolveReturnWorkspace(
  workspaceStore: WorkspaceStore,
  value: unknown,
  userId: string,
): Promise<string | undefined | Response> {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    !(await isAddressedWorkspaceMember(workspaceStore, value, userId))
  ) {
    return apiError(404, "workspace_not_found", "Workspace not found.");
  }
  return value;
}

/** Where a personal sign-in returns: a workspace's Plugins page, and the conversation to reopen there. */
export interface ReturnTarget {
  wsId: string;
  conversationId?: string;
}

/** The one check {@link resolveReturnTarget} asks of the runtime: is this the caller's conversation in that workspace. */
interface ConversationOwnershipCheck {
  assertConversationInWorkspace(
    conversationId: string,
    wsId: string,
    ownerId: string,
  ): Promise<void> | void;
}

/**
 * Read a personal initiate's optional `returnWorkspaceId` and
 * `returnConversationId`. The conversation must be one the caller owns in that
 * workspace (`assertConversationInWorkspace`, the chat door's own check); a
 * conversation with no workspace, another person's, one in another workspace,
 * or a malformed id is refused with the same 404 as a workspace the caller
 * does not reach, so the answer says nothing about which part was wrong.
 */
export async function resolveReturnTarget(
  workspaceStore: WorkspaceStore,
  runtime: ConversationOwnershipCheck,
  body: { returnWorkspaceId: unknown; returnConversationId: unknown },
  userId: string,
): Promise<ReturnTarget | undefined | Response> {
  const wsId = await resolveReturnWorkspace(workspaceStore, body.returnWorkspaceId, userId);
  if (wsId instanceof Response) return wsId;
  const convId = body.returnConversationId;
  if (convId === undefined || convId === null) return wsId ? { wsId } : undefined;
  if (!wsId || typeof convId !== "string") return returnTargetNotFound();
  try {
    await runtime.assertConversationInWorkspace(convId, wsId, userId);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) return returnTargetNotFound();
    throw err;
  }
  return { wsId, conversationId: convId };
}

function returnTargetNotFound(): Response {
  return apiError(404, "workspace_not_found", "Workspace not found.");
}
