import { catalogEntryForRef } from "../connectors/catalog/catalog.ts";
import { serverNameFromRef } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { UserStore } from "../identity/user.ts";
import { log } from "../observability/log.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { isHttpUrl } from "../util/url.ts";
import { isArchiveName, listArchives, purgeArchive } from "../workspace/archives.ts";
import {
  canManageWorkspaceMembers,
  canReadWorkspaceMembers,
  canRenameWorkspace,
} from "../workspace/authz.ts";
import { MAX_WORKSPACE_NAME_CHARS, type WorkspaceMember } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { WORKSPACE_OPTIONAL_META } from "./workspace-optional.ts";

/**
 * Project one tool-supplied connector row onto a `ConnectorRef`. Only the URL and
 * the `serverName` it registers under are accepted from tool input: every other
 * field on a ref (transport, OAuth client, broker coordinates) is
 * operator-catalog territory, set by the install path, never by a caller.
 */
function toConnectorRef(b: Record<string, unknown>): ConnectorRef {
  // The JSON Schema requires `url` but admits any string, including "". A row
  // that reaches the store without a reachable URL is a connector nothing can
  // connect to, and every reader downstream has to defend against it — so it
  // is refused at the boundary that creates it. Same protocol allowlist the
  // install path applies, for the same reason.
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!isHttpUrl(url)) {
    throw new Error(
      `Connector url must be an http(s) URL (got ${url === "" ? "an empty value" : `"${url}"`}).`,
    );
  }
  const serverName = typeof b.serverName === "string" ? b.serverName.trim() : "";
  if (serverName === "") {
    throw new Error(`Connector "${url}" needs a serverName to register it under.`);
  }
  return { url, serverName };
}

/**
 * Map the tool's connector rows to refs, or report the first unusable one.
 *
 * `toConnectorRef` throws so `create` — which maps inside its own try — gets the
 * refusal for free. `update` builds its patch before that try (the
 * nothing-to-update check needs the built patch), so it comes through here and
 * turns the refusal into a tool error rather than an unhandled throw.
 */
function toConnectorRefs(rows: Array<Record<string, unknown>>): ConnectorRef[] | { error: string } {
  try {
    return rows.map(toConnectorRef);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Types ─────────────────────────────────────────────────────────

export interface ManageWorkspacesContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  workspaceStore: WorkspaceStore;
  /**
   * The runtime seam a delete goes through.
   *
   * A workspace owns its connectors, and tearing them down needs the lifecycle,
   * the per-workspace registry, and the credential store — none of which a
   * `WorkspaceStore` has or should have. `Runtime.deleteWorkspace` is where
   * that cascade lives, so the tool holds the runtime rather than reaching past
   * it to the store.
   */
  runtime: Runtime;
  /** Required for member management (user validation, display name enrichment). */
  userStore?: UserStore;
}

/** The context a member action runs with: the store it validates users against is present. */
type MemberActionContext = ManageWorkspacesContext & { userStore: UserStore };

// ── Permission check ──────────────────────────────────────────────

function isAdmin(identity: UserIdentity | null): identity is UserIdentity {
  return identity !== null && ORG_ADMIN_ROLES.has(identity.orgRole);
}

function permissionDenied(): ToolResult {
  return {
    content: textContent("You don't have permission to manage workspaces. Ask an org admin."),
    isError: false,
  };
}

// ── Tool factory ──────────────────────────────────────────────────

export function createManageWorkspacesTool(ctx: ManageWorkspacesContext): InProcessTool {
  return {
    name: "manage_workspaces",
    description:
      "Manage workspaces and their members. Workspace CRUD requires org admin, except a rename (update with only name), which a workspace admin member may also make. Listing members is open to any member of the workspace. Changing members requires org admin or workspace admin membership, so an org admin can seat themselves as admin of any workspace, including one left with no admin member. add_member takes the person's userId or the email of someone in the organization. list_archives and purge_archive (org admin) list the archives deleted workspaces leave under archived/ and permanently remove one, named by its directory. Conversation sharing was removed in Stage 1 of the cross-workspace refactor and returns in Stage 4 with policy-gated primitives.",
    meta: { ui: { visibility: ["app"] }, ...WORKSPACE_OPTIONAL_META },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "update",
            "delete",
            "list",
            "list_archives",
            "purge_archive",
            "add_member",
            "remove_member",
            "update_member",
            "list_members",
          ],
          description: "Action to perform.",
        },
        name: {
          type: "string",
          description:
            "Workspace name (required for create, optional for update). The id of a created workspace is generated and never derived from the name.",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID (required for most actions except create/list).",
        },
        connectors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              serverName: { type: "string" },
            },
            required: ["url", "serverName"],
          },
          description:
            "Connector references — the remote MCP endpoint URL and the server name to register it under (optional for create and update).",
        },
        userId: {
          type: "string",
          description: "User ID (for member actions).",
        },
        email: {
          type: "string",
          description: "Email of someone in the organization, in place of userId (for add_member).",
        },
        role: {
          type: "string",
          enum: ["admin", "member"],
          description: "Workspace role (for add_member, update_member).",
        },
        archive: {
          type: "string",
          description:
            "Archive directory name under archived/, as list_archives returns it (required for purge_archive).",
        },
      },
      required: ["action"],
      // Closed so an argument the tool does not take is refused at the
      // schema boundary rather than silently dropped. The id of a created
      // workspace is always generated; a caller passing `slug` or `id`
      // learns that from the error instead of from the id it gets back.
      additionalProperties: false,
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action);

      // A rename is governance, not CRUD: a workspace admin member may make it
      // too. An update that touches connectors stays with org admins below.
      if (action === "update" && input.connectors === undefined) {
        return dispatchRename(ctx, input);
      }

      // Workspace CRUD and archives — requires org admin
      if (
        ["create", "update", "delete", "list", "list_archives", "purge_archive"].includes(action)
      ) {
        return dispatchWorkspaceAction(ctx, action, input);
      }

      // Member management — requires workspace admin or org admin
      if (["add_member", "remove_member", "update_member", "list_members"].includes(action)) {
        return dispatchMemberAction(ctx, action, input);
      }

      return { content: textContent(`Unknown action: ${action}`), isError: true };
    },
  };
}

/** Gate a name-only update on `canRenameWorkspace`, then rename. */
async function dispatchRename(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return { content: textContent("workspaceId is required for update."), isError: true };
  }
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return { content: textContent(`Workspace not found: ${workspaceId}`), isError: true };
  }
  if (!canRenameWorkspace(ctx.getIdentity(), ws).allowed) {
    return {
      content: textContent(
        "You don't have permission to rename this workspace. Requires org admin or workspace admin membership.",
      ),
      isError: true,
    };
  }
  return handleUpdate(ctx, input);
}

/** Gate workspace CRUD and the archive actions on org admin, then route to its handler. */
async function dispatchWorkspaceAction(
  ctx: ManageWorkspacesContext,
  action: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const identity = ctx.getIdentity();
  if (!isAdmin(identity)) return permissionDenied();

  switch (action) {
    case "create":
      return handleCreate(ctx, input);
    case "update":
      return handleUpdate(ctx, input);
    case "delete":
      return handleDelete(ctx, input);
    case "list":
      return handleList(ctx);
    case "list_archives":
      return handleListArchives(ctx);
    case "purge_archive":
      return handlePurgeArchive(ctx, input);
    default:
      return { content: textContent(`Unknown action: ${action}`), isError: true };
  }
}

/** Validate the store + workspaceId, gate on org admin or workspace-admin membership, then route to its handler. */
async function dispatchMemberAction(
  ctx: ManageWorkspacesContext,
  action: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.userStore) {
    return { content: textContent("Member management not available."), isError: true };
  }
  const memberCtx: MemberActionContext = { ...ctx, userStore: ctx.userStore };
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return { content: textContent("workspaceId is required."), isError: true };
  }
  if (!(await memberActionAllowed(memberCtx, workspaceId, action))) {
    return memberPermissionDenied();
  }

  switch (action) {
    case "add_member":
      return handleAddMember(memberCtx, workspaceId, input);
    case "remove_member":
      return handleRemoveMember(memberCtx, workspaceId, input);
    case "update_member":
      return handleUpdateMember(memberCtx, workspaceId, input);
    case "list_members":
      return handleListMembers(memberCtx, workspaceId);
    default:
      return { content: textContent(`Unknown action: ${action}`), isError: true };
  }
}

// ── Action handlers ───────────────────────────────────────────────

/** The refusal for a name over `MAX_WORKSPACE_NAME_CHARS` code points, or null. */
function nameTooLong(name: string): ToolResult | null {
  let chars = 0;
  for (const _ of name) chars++;
  if (chars <= MAX_WORKSPACE_NAME_CHARS) return null;
  return {
    content: textContent(
      `A workspace name can be at most ${MAX_WORKSPACE_NAME_CHARS} characters (got ${chars}).`,
    ),
    isError: true,
  };
}

async function handleCreate(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name ? String(input.name).trim() : undefined;
  if (!name) {
    return {
      content: textContent("name is required to create a workspace."),
      isError: true,
    };
  }
  const tooLong = nameTooLong(name);
  if (tooLong) return tooLong;

  const connectors = input.connectors as Array<Record<string, unknown>> | undefined;

  try {
    let workspace = await ctx.workspaceStore.create(name);

    // Seat the creator as an `admin` member. `WorkspaceStore.create`
    // intentionally leaves `members: []`, so a freshly created shared
    // workspace has no member able to write its content: workspace-scoped
    // writes require an admin member (`canWriteWorkspaceScoped`), and org
    // role grants none. Seating the creator here gives the workspace that
    // admin from creation onward.
    //
    // `getIdentity()` is guaranteed non-null by the org-admin gate in the
    // `create` handler above; we still guard defensively rather than
    // assume the invariant holds.
    //
    // Partial-failure window: if `addMember` throws after `create` has
    // persisted, the workspace exists with no admin member. That is the
    // stranded state, and an org admin recovers it by seating an admin with
    // `add_member` — so we don't attempt a compensating delete here.
    const identity = ctx.getIdentity();
    if (identity) {
      workspace = await ctx.workspaceStore.addMember(workspace.id, identity.id, "admin");
    }

    // If connectors were provided, update the workspace with them
    if (connectors && connectors.length > 0) {
      const updated = await ctx.workspaceStore.update(workspace.id, {
        connectors: connectors.map(toConnectorRef),
      });
      if (updated) workspace = updated;
    }

    const data = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        connectors: workspace.connectors.map(await connectorDescriber(ctx)),
        memberCount: workspace.members.length,
        createdAt: workspace.createdAt,
      },
    };
    return {
      content: textContent(`Created workspace '${workspace.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleUpdate(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return {
      content: textContent("workspaceId is required for update."),
      isError: true,
    };
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) {
      return { content: textContent("A workspace name cannot be empty."), isError: true };
    }
    const tooLong = nameTooLong(name);
    if (tooLong) return tooLong;
    patch.name = name;
  }
  if (input.connectors !== undefined) {
    const refs = toConnectorRefs(input.connectors as Array<Record<string, unknown>>);
    if (!Array.isArray(refs)) return { content: textContent(refs.error), isError: true };
    patch.connectors = refs;
  }

  if (Object.keys(patch).length === 0) {
    return {
      content: textContent("No fields to update. Provide name or connectors."),
      isError: true,
    };
  }

  try {
    const updated = await ctx.workspaceStore.update(workspaceId, patch);
    if (!updated) {
      return {
        content: textContent(`Workspace not found: ${workspaceId}`),
        isError: true,
      };
    }

    const data = {
      workspace: {
        id: updated.id,
        name: updated.name,
        connectors: updated.connectors.map(await connectorDescriber(ctx)),
        memberCount: updated.members.length,
        updatedAt: updated.updatedAt,
      },
    };
    return {
      content: textContent(`Updated workspace '${updated.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to update workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleDelete(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return {
      content: textContent("workspaceId is required for delete."),
      isError: true,
    };
  }

  try {
    // The runtime seam, not the store: deleting a workspace runs the same
    // teardown as removing each connector it holds, and the store knows nothing
    // about connectors. Per-connector failures come back in `connectors` rather
    // than as a throw — one unreachable vendor must not strand the workspace
    // half-deleted.
    const { deleted, connectors, deleteError } = await ctx.runtime.deleteWorkspace(workspaceId);
    // The archive step failed AFTER the teardown, which is not reversible.
    // Saying only "failed" would describe a no-op; the connectors are gone and
    // the operator has to know that to act.
    //
    // Where the record itself ended up is deliberately NOT claimed. The store
    // throws on both sides of its rename — `mkdir`/destination resolution
    // before it, the archive marker write after it — so a message that named
    // one of those states would be wrong half the time, and the half it got
    // wrong would send an operator looking for a workspace that is already
    // archived. What is true on both sides is the teardown, so say that.
    if (deleteError) {
      return {
        content: textContent(
          `Failed to finish deleting workspace ${workspaceId}: ${deleteError}.` +
            describeConnectorTeardown(
              connectors.length,
              connectors.filter((c) => !c.ok || c.revokeError),
            ) +
            (connectors.length > 0
              ? " That teardown cannot be undone — check whether the workspace still exists before retrying, and reinstall its connectors if it does."
              : ""),
        ),
        structuredContent: { deleted: false, workspaceId, connectors, deleteError },
        isError: true,
      };
    }
    if (!deleted) {
      return {
        content: textContent(`Workspace not found: ${workspaceId}`),
        isError: true,
      };
    }

    const failed = connectors.filter((c) => !c.ok || c.revokeError);
    const data = { deleted: true, workspaceId, connectors };
    return {
      content: textContent(
        `Deleted workspace ${workspaceId}.${describeConnectorTeardown(connectors.length, failed)}`,
      ),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to delete workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * One sentence about what the delete tore down, silent when the workspace held
 * no connectors.
 *
 * A failure is named rather than counted: on the success path the workspace
 * record is gone, so this notice is the last place the connector whose grant
 * may still be live at a vendor can be identified.
 */
function describeConnectorTeardown(total: number, failed: Array<{ serverName: string }>): string {
  if (total === 0) return "";
  const torn = ` Tore down ${total} connector${total === 1 ? "" : "s"}.`;
  if (failed.length === 0) return torn;
  // A row that named no server has no name to print; say so rather than
  // quoting an empty string at an operator who then has nothing to search for.
  const names = failed
    .map((f) => (f.serverName ? `"${f.serverName}"` : "an unnamed connector row"))
    .join(", ");
  return `${torn} ${names} did not tear down cleanly — check the workspace's grants at the vendor.`;
}

/** One installed connector as this tool reports it. */
interface ConnectorSummary {
  serverName: string;
  name: string;
  /** The catalog entry's icon, when it ships one; the UI falls back to a letter avatar. */
  iconUrl?: string;
}

/**
 * How every action of this tool reports a workspace's connectors: by name, never
 * by ref. A ref carries transport auth, headers and OAuth client config, any of
 * which may hold an inline secret. The name and icon come from the catalog, as
 * on the Connectors page. Resolves the catalog once, so a caller maps many refs cheaply.
 */
async function connectorDescriber(
  ctx: ManageWorkspacesContext,
): Promise<(ref: ConnectorRef) => ConnectorSummary> {
  const catalog = ctx.runtime.getConnectorCatalog();
  const [byUrl, byId] = await Promise.all([catalog.catalogByUrl(), catalog.catalogByIdMap()]);
  return (ref) => {
    const serverName = serverNameFromRef(ref) ?? ref.url;
    const entry = catalogEntryForRef(ref, byUrl, byId);
    const name = entry?.name ?? serverName;
    return { serverName, name, ...(entry?.iconUrl ? { iconUrl: entry.iconUrl } : {}) };
  };
}

async function handleList(ctx: ManageWorkspacesContext): Promise<ToolResult> {
  try {
    const workspaces = await ctx.workspaceStore.list();
    const identity = ctx.getIdentity();
    const describe = await connectorDescriber(ctx);
    const result = workspaces.map((ws) => {
      const userRole = identity
        ? ws.members.find((m) => m.userId === identity.id)?.role
        : undefined;
      return {
        id: ws.id,
        name: ws.name,
        memberCount: ws.members.length,
        connectors: ws.connectors.map(describe),
        createdAt: ws.createdAt,
        // The requester's role within this workspace, when applicable. Lets the
        // web client gate workspace-admin UI without an extra `list_members`
        // round-trip per workspace.
        ...(userRole ? { userRole } : {}),
      };
    });
    const data = { workspaces: result };
    return {
      content: textContent(`${result.length} workspace(s).`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to list workspaces: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleListArchives(ctx: ManageWorkspacesContext): Promise<ToolResult> {
  try {
    const archives = await listArchives(ctx.workspaceStore.getArchivedDir());
    return {
      content: textContent(`${archives.length} archive(s).`),
      structuredContent: { archives },
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to list archives: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Permanently remove one archive. There is no undo, so the web tab confirms
 * with the size first; this handler refuses anything that is not a direct
 * child of `archived/` and treats an absent archive as already purged.
 */
async function handlePurgeArchive(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const archive = typeof input.archive === "string" ? input.archive : "";
  if (!isArchiveName(archive)) {
    return {
      content: textContent(
        archive === ""
          ? "archive is required for purge_archive."
          : `"${archive}" is not an archive name. Use a name list_archives returned.`,
      ),
      isError: true,
    };
  }

  try {
    const result = await purgeArchive(ctx.workspaceStore.getArchivedDir(), archive);
    if (result.purged) {
      log.info("[manage_workspaces] archive purged", { archive, sizeBytes: result.sizeBytes });
    }
    return {
      content: textContent(
        result.purged
          ? `Purged archive ${archive} (${result.sizeBytes} bytes).`
          : `Archive ${archive} does not exist; nothing to purge.`,
      ),
      structuredContent: { ...result },
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to purge archive: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// Member actions
// ══════════════════════════════════════════════════════════════════

/**
 * Check whether the requesting user may take a member action in the given
 * workspace. Listing is open to any member (`canReadWorkspaceMembers`);
 * changing the roster needs an org admin/owner or an `admin` member of this
 * workspace (`canManageWorkspaceMembers`).
 */
async function memberActionAllowed(
  ctx: MemberActionContext,
  workspaceId: string,
  action: string,
): Promise<boolean> {
  const identity = ctx.getIdentity();
  const ws = await ctx.workspaceStore.get(workspaceId);
  const decide = action === "list_members" ? canReadWorkspaceMembers : canManageWorkspaceMembers;
  return decide(identity, ws).allowed;
}

/**
 * Record a roster change with its actor. An org admin may change any
 * workspace's roster, including seating and unseating themselves, so the log
 * is what shows who reached into a workspace after they leave its roster.
 */
function logMemberChange(
  ctx: MemberActionContext,
  change: string,
  workspaceId: string,
  userId: string,
  role?: string,
): void {
  log.info(`[manage_members] member ${change}`, {
    actorId: ctx.getIdentity()?.id,
    workspaceId,
    userId,
    ...(role ? { role } : {}),
  });
}

function memberPermissionDenied(): ToolResult {
  return {
    content: textContent(
      "You don't have permission to manage members. Requires org admin or workspace admin membership.",
    ),
    isError: false,
  };
}

/** Map a thrown mutation error to a ToolResult. */
function mutationErrorResult(err: unknown, action: string): ToolResult {
  return {
    content: textContent(
      `Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`,
    ),
    isError: true,
  };
}

// ── Member action handlers ────────────────────────────────────────

/**
 * The person `add_member` names: by `userId`, or by `email` for a caller who
 * cannot list the organization's users (a workspace admin who is not an org
 * admin). An email matches case-insensitively, and a deactivated account is not
 * offered, so the caller learns only whether an active person in the org has it.
 */
async function resolveNewMember(
  ctx: MemberActionContext,
  input: Record<string, unknown>,
): Promise<{ id: string } | { error: string }> {
  if (input.userId) {
    const user = await ctx.userStore.get(String(input.userId));
    return user ? { id: user.id } : { error: "User not found" };
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email) return { error: "userId or email is required to add a member." };
  const user = (await ctx.userStore.list()).find(
    (u) => !u.deletedAt && u.email.toLowerCase() === email,
  );
  return user ? { id: user.id } : { error: `No one in this organization has the email ${email}.` };
}

async function handleAddMember(
  ctx: MemberActionContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const user = await resolveNewMember(ctx, input);
  if ("error" in user) {
    return { content: textContent(user.error), isError: true };
  }
  const userId = user.id;

  const role = input.role ? String(input.role) : "member";
  if (role !== "admin" && role !== "member") {
    return {
      content: textContent(`Invalid role: ${role}. Must be "admin" or "member".`),
      isError: true,
    };
  }

  try {
    const ws = await ctx.workspaceStore.addMember(workspaceId, userId, role);
    logMemberChange(ctx, "added", workspaceId, userId, role);
    const data = {
      added: { userId, role },
      workspace: { id: ws.id, memberCount: ws.members.length },
    };
    return {
      content: textContent(`Added member ${userId} to workspace.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to add member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Count workspace admins whose underlying user is still active (not
 * soft-deleted). The last-admin guards use this so a deactivated admin — who
 * can't actually act, since the auth layer denies them — never counts toward
 * the minimum. Mirrors `activeOwnerCount` in user-tools.ts at the workspace level.
 */
async function activeAdminCount(members: WorkspaceMember[], userStore: UserStore): Promise<number> {
  const admins = members.filter((m) => m.role === "admin");
  const users = await Promise.all(admins.map((m) => userStore.get(m.userId)));
  return users.filter((u) => !u?.deletedAt).length;
}

/** Block acting on the workspace's last active admin; returns the error ToolResult, or null to proceed. */
async function lastActiveAdminGuard(
  ctx: MemberActionContext,
  members: WorkspaceMember[],
  userId: string,
  message: string,
): Promise<ToolResult | null> {
  // Only guard when the target is an active admin — acting on an already
  // deactivated admin can't drop the active-admin count below the minimum.
  const targetUser = await ctx.userStore.get(userId);
  if (!targetUser?.deletedAt && (await activeAdminCount(members, ctx.userStore)) <= 1) {
    return { content: textContent(message), isError: true };
  }
  return null;
}

async function handleRemoveMember(
  ctx: MemberActionContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required to remove a member."),
      isError: true,
    };
  }

  // Safety: cannot remove last workspace admin
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) {
    return {
      content: textContent(`User "${userId}" is not a member of this workspace.`),
      isError: true,
    };
  }

  if (target.role === "admin") {
    // Only guard when the target is an active admin — removing an already
    // deactivated admin can't drop the active-admin count below the minimum.
    const targetUser = await ctx.userStore.get(userId);
    if (!targetUser?.deletedAt && (await activeAdminCount(ws.members, ctx.userStore)) <= 1) {
      return {
        content: textContent("Cannot remove the last workspace admin."),
        isError: true,
      };
    }
  }

  try {
    const updated = await ctx.workspaceStore.removeMember(workspaceId, userId);
    logMemberChange(ctx, "removed", workspaceId, userId);
    const data = {
      removed: { userId },
      workspace: { id: updated.id, memberCount: updated.members.length },
    };
    return {
      content: textContent("Removed member from workspace."),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to remove member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleUpdateMember(
  ctx: MemberActionContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required to update a member."),
      isError: true,
    };
  }

  const role = input.role ? String(input.role) : undefined;
  if (!role) {
    return {
      content: textContent("role is required to update a member."),
      isError: true,
    };
  }

  if (role !== "admin" && role !== "member") {
    return {
      content: textContent(`Invalid role: ${role}. Must be "admin" or "member".`),
      isError: true,
    };
  }

  // Safety: if demoting an admin, ensure they're not the last one
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) {
    return {
      content: textContent(`User "${userId}" is not a member of this workspace.`),
      isError: true,
    };
  }

  if (target.role === "admin" && role === "member") {
    const guard = await lastActiveAdminGuard(
      ctx,
      ws.members,
      userId,
      "Cannot demote the last workspace admin.",
    );
    if (guard) return guard;
  }

  try {
    const updated = await ctx.workspaceStore.updateMemberRole(workspaceId, userId, role);
    logMemberChange(ctx, "role updated", workspaceId, userId, role);
    const member = updated.members.find((m) => m.userId === userId);
    const data = {
      updated: { userId, role: member?.role },
      workspace: { id: updated.id, memberCount: updated.members.length },
    };
    return {
      content: textContent("Updated role for member."),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return mutationErrorResult(err, "update member");
  }
}

async function handleListMembers(
  ctx: MemberActionContext,
  workspaceId: string,
): Promise<ToolResult> {
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  // Enrich members with display names and emails from user profiles. Deactivated
  // (soft-deleted) members keep their membership for clean restore, so surface
  // deletedAt here too — the member still appears, flagged, rather than as a
  // normal member (the second of the two surfaces the soft-delete fix targets).
  const enrichedMembers = await Promise.all(
    ws.members.map(async (m) => {
      const user = await ctx.userStore.get(m.userId);
      return {
        userId: m.userId,
        role: m.role,
        displayName: user?.displayName ?? m.userId,
        email: user?.email ?? "",
        ...(user?.deletedAt ? { deletedAt: user.deletedAt } : {}),
      };
    }),
  );

  const data = {
    workspaceId: ws.id,
    members: enrichedMembers,
  };
  return {
    content: textContent(`${enrichedMembers.length} member(s) in workspace.`),
    structuredContent: data,
    isError: false,
  };
}
