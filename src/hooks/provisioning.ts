import { log } from "../observability/log.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { assertForwardablePath } from "./declaration.ts";
import { registrationKey, updateRegistrations, withRotatedKid } from "./registrations.ts";
import { buildHookUrl, type HookIdentity, newKid, sealHookToken } from "./token.ts";
import type { HookDeclaration, HookRegistration } from "./types.ts";

/**
 * Minting, handing over, and retiring hook URLs.
 *
 * The two failure modes here are deliberately NOT the same severity, and the
 * line between them is the one thing to preserve if this file is ever
 * refactored:
 *
 *   - A **contract violation** — a declared `register_tool` that does not exist
 *     on the server, or does not accept `{vendor, url}` — throws
 *     {@link HookContractError} and provisions nothing. The runtime would
 *     otherwise mint a capability it has no way to deliver, and the symptom
 *     would be "the vendor never sends anything", surfacing months later at a
 *     vendor nobody is watching. Naming it at install turns an invisible
 *     failure into a legible one.
 *
 *     It does NOT refuse the install. The check needs the server's tool list,
 *     which needs a started source, which the install pipeline does not reach
 *     until after the bundle ref is committed — so by the time this can run,
 *     the install has succeeded and reporting otherwise would describe state
 *     the runtime kept. The caller surfaces it as a warning on a successful
 *     install instead, and the reconcile re-runs it on every transition to
 *     `running` so it stays visible rather than firing once.
 *
 *   - A **transient failure** — the registration tool exists but the call fails
 *     (the server is starting, the operator has denied that tool by permission,
 *     the vendor's API is down) — records the `kid` and logs. A connector is
 *     useful without its webhook; the receiving bundle's own reconcile poll is
 *     the designed backstop for a stream that never arrives, and the recorded
 *     registration means a later `rotate_hook` or re-install retries it.
 */

/** What a server must accept on its declared registration tool. */
const REGISTER_TOOL_REQUIRED_PROPS = ["vendor", "url"] as const;

export class HookContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookContractError";
  }
}

/**
 * Check a declaration's `register_tool` against the server's advertised tool
 * list — that it exists, and that its input schema accepts the two string
 * properties the runtime will send.
 *
 * The existence check alone would leave half the interface undocumented: the
 * manifest names a tool, but the ARGUMENT SHAPE the runtime calls it with
 * appears in no schema a third-party author can read. Verifying the advertised
 * `inputSchema` here turns "we hope you guessed `{vendor, url}`" into a
 * contract that fails loudly at install, and it costs nothing extra — the tool
 * list is already being fetched for the existence check.
 *
 * The check is deliberately permissive about HOW the properties are declared
 * (it only requires that they appear and are not typed as something other than
 * a string): a server may reasonably add its own optional arguments, and this
 * is a compatibility gate, not a schema validator.
 */
export function verifyRegisterTool(tools: Tool[], decl: HookDeclaration, connector: string): void {
  const tool = tools.find((t) => t.name === decl.register_tool);
  if (!tool) {
    throw new HookContractError(
      `Connector "${connector}" declares hook "${decl.vendor}" with register_tool ` +
        `"${decl.register_tool}", which is not on its tool list. A hook whose registration ` +
        `tool is missing can never be handed its URL.`,
    );
  }
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
  for (const required of REGISTER_TOOL_REQUIRED_PROPS) {
    const prop = props[required] as { type?: unknown } | undefined;
    if (!prop) {
      throw new HookContractError(
        `Connector "${connector}" declares hook "${decl.vendor}" with register_tool ` +
          `"${decl.register_tool}", which does not accept a "${required}" argument. ` +
          `The runtime calls it with { vendor, url }.`,
      );
    }
    if (prop.type !== undefined && prop.type !== "string") {
      throw new HookContractError(
        `Connector "${connector}" declares hook "${decl.vendor}" with register_tool ` +
          `"${decl.register_tool}", whose "${required}" argument is typed ` +
          `"${String(prop.type)}"; the runtime sends a string.`,
      );
    }
  }
}

/** The narrow slice of a connector's source that provisioning needs. */
export interface HookConnectorPort {
  /** Advertised tool list, for the install-time contract check. */
  tools(): Promise<Tool[]>;
  /** Invoke a tool by its bare name, through the ordinary MCP dispatch path. */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
}

export interface ProvisionHooksOptions {
  identity: HookIdentity;
  store: WorkspaceStore;
  wsId: string;
  connector: string;
  declarations: HookDeclaration[];
  port: HookConnectorPort;
  /** Mint a fresh `kid` for every declaration even if one is already recorded.
   *  This is what `rotate_hook` sets; an install reuses a live `kid` so a
   *  reinstall does not invalidate a URL the vendor is happily delivering to. */
  rotate?: boolean;
  /** Restrict the operation to one vendor. Used by `rotate_hook`. */
  onlyVendor?: string;
}

export interface ProvisionedHook {
  vendor: string;
  kid: string;
  /** Whether the server's `register_tool` accepted the URL. A `false` here is
   *  the transient case: the registration is recorded, the vendor does not have
   *  the URL yet, and a retry is a rotation away. */
  registered: boolean;
  /** Failure detail when `registered` is false. Never contains the URL. */
  error?: string;
}

/** One minted stream, held between the persist and the hand-over. */
interface MintedHook {
  reg: HookRegistration;
  decl: HookDeclaration;
  url: string;
}

/**
 * The registration this declaration should hold after the operation.
 *
 * An install REUSES a live `kid`: re-minting on every reinstall would silently
 * retire a URL the vendor is happily delivering to, and the reinstall
 * re-registers anyway, so the churn buys nothing. Only an explicit `rotate`
 * mints a new one — and then `withRotatedKid` carries the outgoing `kid` into
 * the grace window, which is why rotation goes through that one function rather
 * than being open-coded here.
 */
function nextRegistration(
  existing: HookRegistration | undefined,
  opts: ProvisionHooksOptions,
  decl: HookDeclaration,
): HookRegistration {
  const kid = existing && !opts.rotate ? existing.kid : newKid();
  if (existing && kid === existing.kid) {
    return { ...existing, route: decl.route, headerRenames: decl.header_renames };
  }
  return withRotatedKid(existing, {
    connector: opts.connector,
    vendor: decl.vendor,
    kid,
    route: decl.route,
    headerRenames: decl.header_renames,
  });
}

/** Seal a capability for one stream and build the URL the server is handed. */
function mintUrl(opts: ProvisionHooksOptions, decl: HookDeclaration, kid: string): string {
  return buildHookUrl(
    opts.connector,
    decl.vendor,
    sealHookToken(
      {
        tid: opts.identity.tid,
        wid: opts.wsId,
        connector: opts.connector,
        vendor: decl.vendor,
        kid,
      },
      opts.identity.key,
    ),
  );
}

/**
 * Mint (or rotate) every declared hook for one connector in one workspace, and
 * hand each URL to the server that declared it.
 *
 * Verification of the whole declaration set happens FIRST, before any hook state
 * is written, so a manifest with one bad declaration provisions nothing at all
 * rather than half of its streams.
 */
export async function provisionHooks(opts: ProvisionHooksOptions): Promise<ProvisionedHook[]> {
  const declarations = opts.onlyVendor
    ? opts.declarations.filter((d) => d.vendor === opts.onlyVendor)
    : opts.declarations;
  if (declarations.length === 0) return [];

  const tools = await opts.port.tools();
  for (const decl of declarations) {
    assertForwardablePath(decl.route, `connector "${opts.connector}" hook "${decl.vendor}"`);
    verifyRegisterTool(tools, decl, opts.connector);
  }

  // One read-modify-write for the whole set: a per-declaration write would make
  // a multi-stream connector's install N racing updates against the same record.
  const minted = new Map<string, MintedHook>();
  const written = await updateRegistrations(opts.store, opts.wsId, (current) => {
    for (const decl of declarations) {
      const key = registrationKey(opts.connector, decl.vendor);
      const reg = nextRegistration(current[key], opts, decl);
      current[key] = reg;
      minted.set(decl.vendor, { reg, decl, url: mintUrl(opts, decl, reg.kid) });
    }
    return current;
  });

  // The write is what makes a `kid` admissible at the door, so a workspace that
  // disappeared mid-install must not lead to handing a server a URL that every
  // delivery would then 404. Mint, persist, THEN register — never the reverse.
  if (!written) return [];

  const results: ProvisionedHook[] = [];
  for (const [vendor, mint] of minted) {
    results.push(await handOverUrl(opts, vendor, mint));
  }
  return results;
}

/**
 * Hand one minted URL to the server that declared the stream.
 *
 * A failure here is NOT fatal and NOT an error-level event. The connector is
 * installed and useful; the receiving bundle's own reconcile poll is the
 * designed backstop for a stream that never arrives; and the registration is
 * already recorded, so a later `rotate_hook` or reinstall retries. What the
 * operator needs is to know the stream is not live yet, which the warn line and
 * `list_hooks` both give them.
 */
async function handOverUrl(
  opts: ProvisionHooksOptions,
  vendor: string,
  { reg, decl, url }: MintedHook,
): Promise<ProvisionedHook> {
  let error: string | undefined;
  try {
    const result = await opts.port.execute(decl.register_tool, { vendor, url });
    if (!result.isError) return { vendor, kid: reg.kid, registered: true };
    error = summarizeToolError(result);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  log.warn("[hooks] registration tool did not accept the minted URL", {
    connector: opts.connector,
    vendor,
    kid: reg.kid,
    tool: decl.register_tool,
    reason: error,
  });
  return { vendor, kid: reg.kid, registered: false, error };
}

/**
 * Drop every registration a connector owns in one workspace.
 *
 * Called on uninstall. It is not the only thing that stops a delivery — the
 * door independently requires the connector to still be installed, because it
 * needs the connector's base URL to have anywhere to forward to — but leaving
 * retired registrations behind would let a later reinstall silently resurrect a
 * `kid` whose URL had been in the wild the whole time.
 */
export async function revokeHooksForConnector(
  store: WorkspaceStore,
  wsId: string,
  connector: string,
): Promise<number> {
  let removed = 0;
  await updateRegistrations(store, wsId, (current) => {
    for (const [key, reg] of Object.entries(current)) {
      if (reg.connector === connector) {
        delete current[key];
        removed++;
      }
    }
    // No write when there was nothing to remove — a connector without hooks is
    // the common case and should not churn `updatedAt` on every uninstall.
    return removed > 0 ? current : null;
  });
  return removed;
}

/** First line of a tool error result, for a log field. Bounded so a verbose
 *  server cannot write an unbounded log line. */
function summarizeToolError(result: ToolResult): string {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return (text ?? "tool returned an error").split("\n")[0]?.slice(0, 200) ?? "tool error";
}
