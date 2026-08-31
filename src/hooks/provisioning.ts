import { log } from "../observability/log.ts";
import type { Tool, ToolResult, ToolSource } from "../tools/types.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { assertForwardablePath } from "./declaration.ts";
import { registrationKey, updateRegistrations, withRotatedKid } from "./registrations.ts";
import { buildHookUrl, type HookIdentity, newKid, sealHookToken } from "./token.ts";
import type { HookDeclaration, HookRegistration } from "./types.ts";

/**
 * Minting, handing over, and retiring hook URLs.
 *
 * The three outcomes short of a live stream are deliberately NOT the same
 * severity, and the lines between them are the one thing to preserve if this
 * file is ever refactored:
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
 *   - **Not ready** — the source is up but advertises no tools yet. Nothing is
 *     written and nothing is reported as wrong. It is indistinguishable, at the
 *     level of a tool list, from a source that has not started, and it is
 *     answered the same way: defer, and let the next reconcile provision. What
 *     makes this its own case rather than a contract violation is that every
 *     declared name is absent from an empty list, so folding the two together
 *     accuses a correct manifest of a fault it does not have.
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
 *
 * `tools` must be the source's POPULATED list. Every name is absent from an
 * empty one, so calling this with an empty list would report a correct manifest
 * as a contract violation — the caller separates the two (see
 * {@link provisionHooks}).
 */
export function verifyRegisterTool(tools: Tool[], decl: HookDeclaration, connector: string): void {
  const tool = tools.find((t) => t.name === decl.register_tool);
  if (!tool) {
    throw new HookContractError(
      `Connector "${connector}" declares hook "${decl.vendor}" with register_tool ` +
        `"${decl.register_tool}", which is not among the ${tools.length} tools its server ` +
        `advertises (${summarizeToolNames(tools)}). A hook whose registration tool is ` +
        `missing can never be handed its URL.`,
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

/**
 * The narrow slice of a connector's source that provisioning needs.
 *
 * **Both halves speak the BARE tool name** — the same vocabulary a declaration's
 * `register_tool` is written in. A registry source does not: it advertises
 * `<source>__<tool>` and takes the bare name on `execute`, because the
 * qualified form is what routes a call to the right source in a workspace-wide
 * tool list. Provisioning is already inside one source and has no such
 * question to answer, so the port answers in one vocabulary and
 * {@link hookPortForSource} is the single place the two meet.
 */
export interface HookConnectorPort {
  /** Advertised tools, named as a declaration names them. For the contract check. */
  tools(): Promise<Tool[]>;
  /** Invoke a tool by its bare name, through the ordinary MCP dispatch path. */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Subscribe to "this source's tool set may have changed", returning an
   * unsubscribe. The reconcile's retrigger; see `watchToolSurface` in
   * `reconcile.ts` for why provisioning needs one.
   *
   * Optional because the underlying `ToolSource` method is: a source whose
   * tools are fixed at construction never fires one, and a port without it
   * simply has no retrigger.
   */
  subscribeToolsChanged?(listener: () => void): () => void;
}

/** The `tools()`/`execute()`/`subscribeToolsChanged()` slice of a registry source. */
type HookSourceLike = Pick<ToolSource, "tools" | "execute" | "subscribeToolsChanged">;

/**
 * Adapt a registry source to the port, translating its advertised
 * `<source>__<tool>` names down to the bare names a declaration uses.
 *
 * Without the translation every declared `register_tool` is absent from every
 * tool list, so a correct manifest is reported as a contract violation and no
 * stream is ever provisioned. The two names are decomposed by
 * `splitInnerToolName`, the one grammar every door shares — a hand-rolled
 * `slice` here would be a second one.
 */
export function hookPortForSource(source: HookSourceLike): HookConnectorPort {
  return {
    tools: async () =>
      (await source.tools()).map((t) => ({ ...t, name: splitInnerToolName(t.name).bareToolName })),
    execute: (toolName, input) => source.execute(toolName, input),
    subscribeToolsChanged: source.subscribeToolsChanged?.bind(source),
  };
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
  // An empty tool list is NOT a contract violation, and the difference is the
  // whole reason this branch exists. A contract violation says "this manifest
  // is wrong, no retry will help"; an empty list says the source is up but has
  // not advertised anything yet — a start that is still completing, a server
  // registering its tools after the handshake. Every declared name is absent
  // from an empty list, so checking one against it would accuse a manifest that
  // is correct and send the reader to re-read it. It is the same state as a
  // source that is not running: nothing has been written, so nothing is half
  // done, and the reconcile runs again when the tool set materializes.
  if (tools.length === 0) {
    log.debug(
      "mcp",
      `[hooks] ${opts.connector} is running but advertises no tools yet — deferring`,
    );
    return [];
  }
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

/**
 * The advertised names, for a contract error that has to be actionable.
 *
 * A message that only names what is MISSING sends the reader to re-read a
 * manifest; naming what the server actually serves lets them see the mismatch —
 * a rename, a tool behind a flag the deployment does not set.
 *
 * Bounded on BOTH axes, because both are the server's to choose: a hundred tools
 * named at a hundred characters each is the same unbounded log line as a
 * thousand tools, and the names come off the wire.
 */
function summarizeToolNames(tools: Tool[]): string {
  const shown = tools.slice(0, 12).map((t) => t.name.slice(0, 60));
  const joined = shown.join(", ");
  return tools.length > shown.length ? `${joined}, …` : joined;
}

/** First line of a tool error result, for a log field. Bounded so a verbose
 *  server cannot write an unbounded log line. */
function summarizeToolError(result: ToolResult): string {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return (text ?? "tool returned an error").split("\n")[0]?.slice(0, 200) ?? "tool error";
}
