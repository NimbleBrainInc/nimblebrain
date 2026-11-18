import type { McpSubcommand } from "./args.ts";
import { hostLoopback, paths } from "./compose.ts";
import type { Ctx } from "./lifecycle.ts";
import { CliError, type ErrorCode, type Ok } from "./result.ts";
import { isUp, readInstall, readWorkspaces } from "./status.ts";

/**
 * `mcp add | list | remove`: a thin client of the local instance's API, for
 * developing an MCP server against it (ADR-0065). Each calls the
 * `manage_connectors` actions the web shell's Connectors page calls, through
 * `/v1/workspaces/<wsId>/tools/call`, and answers in the CLI's contract. The
 * runtime owns the rows it stores; the CLI stores nothing and restarts nothing.
 *
 * No credential and no `Origin`: the local instance uses the `dev` adapter, and
 * the tool-call door refuses only a browser origin it does not trust.
 */
export async function mcp(ctx: Ctx): Promise<Ok> {
  const sub = ctx.arg as McpSubcommand;
  const target = await reach(ctx, sub === "add");
  if (sub === "add") return add(target, ctx.operand ?? "", ctx.flags.name);
  if (sub === "list") return list(target);
  return remove(target, ctx.operand ?? "");
}

/** The runtime's coded refusals of a `direct-url` install, each its own CLI code. */
const RUNTIME_CODES = [
  "DIRECT_URL_NOT_ALLOWED",
  "URL_NOT_LOOPBACK",
  "URL_INVALID",
  "INVALID_SERVER_NAME",
  "NAME_TAKEN",
  "NAME_IS_CATALOG_ENTRY",
] as const satisfies readonly ErrorCode[];

/** An install may take a while: the runtime fetches the server's card and connects to it. */
const ADD_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 15_000;

interface Target {
  ctx: Ctx;
  url: string;
  wsId: string;
}

/**
 * The running instance and the workspace to act in: `--workspace`, else the
 * first workspace, which is the one `init` connects the agent to. `add` first
 * needs a release whose Compose file lets the runtime reach this machine.
 */
async function reach(ctx: Ctx, adding: boolean): Promise<Target> {
  const { deps, home, flags } = ctx;
  const install = await readInstall(deps, home);
  if (!install) throw new CliError("NOT_INSTALLED", `No NimbleBrain install in ${home}.`);
  if (adding && !hostLoopback((await deps.readText(paths(home).compose)) ?? "")) {
    throw new CliError(
      "UPDATE_REQUIRED",
      `NimbleBrain ${install.version} cannot reach a server on this machine.`,
      { version: install.version },
    );
  }
  const url = `http://127.0.0.1:${install.port}`;
  if (!(await isUp(deps, url))) throw new CliError("NOT_RUNNING", "NimbleBrain is not running.");
  const workspaces = await readWorkspaces(deps, url);
  const ws = flags.workspace ? workspaces.find((w) => w.id === flags.workspace) : workspaces[0];
  if (!ws) {
    throw new CliError(
      "WORKSPACE_NOT_FOUND",
      flags.workspace
        ? `No workspace "${flags.workspace}" on this install.`
        : "This install has no workspace.",
      { workspaces: workspaces.map((w) => w.id) },
    );
  }
  return { ctx, url, wsId: ws.id };
}

async function add(t: Target, serverUrl: string, name: string | undefined): Promise<Ok> {
  // The runtime refuses a URL that is not `http(s)` without a code, so it is
  // refused here first, under the code the runtime gives a URL it cannot use.
  const protocol = URL.canParse(serverUrl) ? new URL(serverUrl).protocol : "";
  if (protocol !== "http:" && protocol !== "https:") {
    throw new CliError("URL_INVALID", `"${serverUrl}" is not an http or https URL.`);
  }
  const install = { kind: "direct-url", url: serverUrl, ...(name ? { serverName: name } : {}) };
  const s = await call(
    t,
    {
      action: "install",
      entry: { id: "direct-url", name: name ?? serverUrl, install },
    },
    ADD_TIMEOUT_MS,
  );
  return {
    ok: true,
    serverName: s.serverName,
    url: s.url,
    dialed: s.dialed,
    placements: s.placements,
    wsId: s.wsId ?? t.wsId,
    ...(s.warning ? { warning: s.warning } : {}),
    ...(s.notice ? { notice: s.notice } : {}),
  };
}

/** One connector as `list` reports it: what a person needs to recognise and fix it. */
interface Server {
  serverName: string;
  displayName?: string;
  url?: string;
  state?: string;
  status?: string;
  statusReason?: string;
  toolCount?: number;
}

async function list(t: Target): Promise<Ok> {
  const s = await call(t, { action: "list_installed", scope: "workspace" }, CALL_TIMEOUT_MS);
  const installed = Array.isArray(s.installed) ? (s.installed as Server[]) : [];
  const servers = installed.map((e) => ({
    serverName: e.serverName,
    displayName: e.displayName,
    url: e.url,
    state: e.state,
    status: e.status,
    statusReason: e.statusReason,
    toolCount: e.toolCount,
  }));
  return { ok: true, wsId: t.wsId, servers };
}

/**
 * Removes a connector from the workspace. A name the workspace does not have
 * is `SERVER_NOT_FOUND`, read from the list first: the runtime's own refusal
 * of it carries no code to branch on.
 */
async function remove(t: Target, serverName: string): Promise<Ok> {
  const listed = await call(t, { action: "list_installed", scope: "workspace" }, CALL_TIMEOUT_MS);
  const installed = Array.isArray(listed.installed) ? (listed.installed as Server[]) : [];
  if (!installed.some((e) => e.serverName === serverName)) {
    throw new CliError("SERVER_NOT_FOUND", `This workspace has no server named "${serverName}".`, {
      wsId: t.wsId,
    });
  }
  await call(t, { action: "uninstall", serverName }, CALL_TIMEOUT_MS);
  return { ok: true, serverName, wsId: t.wsId };
}

interface ToolAnswer {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

/** One `manage_connectors` call in the target workspace; its `structuredContent`, or the error it maps to. */
async function call(
  t: Target,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await t.ctx.deps.postJson(
    `${t.url}/v1/workspaces/${encodeURIComponent(t.wsId)}/tools/call`,
    { server: "nb", tool: "manage_connectors", arguments: args },
    timeoutMs,
  );
  if (!res) throw new CliError("NOT_RUNNING", "NimbleBrain did not answer.");
  const body = (res.body ?? {}) as ToolAnswer & { error?: unknown; message?: unknown };
  if (res.status === 404 && body.error === "workspace_error") {
    throw new CliError("WORKSPACE_NOT_FOUND", `No workspace "${t.wsId}" on this install.`);
  }
  if (res.status < 200 || res.status >= 300) {
    const why = typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new CliError("REQUEST_FAILED", `NimbleBrain refused the request: ${why}`, {
      status: res.status,
    });
  }
  const text = body.content?.find((c) => c.type === "text")?.text;
  if (body.isError) {
    const code = body.structuredContent?.error;
    const known = RUNTIME_CODES.find((c) => c === code);
    throw new CliError(known ?? "REQUEST_FAILED", text ?? "NimbleBrain refused the request.");
  }
  return body.structuredContent ?? {};
}
