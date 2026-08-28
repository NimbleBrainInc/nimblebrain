/**
 * The hooks door — inbound vendor deliveries, and the one thing the kernel
 * contributes to them.
 *
 * A vendor (a campaign platform, a payment processor, anything with a
 * "webhook URL" field) delivers events over plain HTTPS. It cannot carry a
 * platform token, so it cannot enter through the fleet edge. Something has to
 * decide which `(tenant, workspace)` that delivery belongs to, and the runtime
 * is the only component entitled to decide it: shared services verify a
 * workspace claim, they never originate one, and a bundle asserting its own
 * workspace would be the whole isolation model inverted.
 *
 * So the runtime provides ONE generic door and originates identity on it. It
 * never learns what a vendor body means:
 *
 *   - The server DECLARES its inbound streams in `_meta["ai.nimblebrain/host"]`
 *     ({@link HookDeclaration}) — a vendor slug, a route on itself, and the
 *     tool to hand the minted URL to.
 *   - At install the runtime MINTS a capability URL for exactly one
 *     `(tenant, workspace, connector, vendor)` and hands it to that tool.
 *   - On delivery the runtime OPENS the capability, mints its ordinary
 *     workspace-scoped platform token, and FORWARDS the bytes unchanged to the
 *     declared route through the edge.
 *
 * Everything about meaning — signature verification, parsing, idempotency,
 * state — belongs to the server that declared the stream. If runtime code ever
 * reads a field out of a delivery body, this split has failed.
 */

/**
 * One inbound stream a server declares, in
 * `_meta["ai.nimblebrain/host"].hooks[]`.
 *
 * This is the entire vendor-specific configuration the runtime ever sees. It
 * carries a name, a route, a tool, and prose — no payload shapes, no event
 * taxonomies. That constraint is what makes the door generic: a third-party
 * server declaring `{vendor: "stripe", route: "/ingest/stripe", ...}` gets
 * byte-identical treatment to a first-party one, because there is nothing here
 * for the runtime to special-case on.
 */
export interface HookDeclaration {
  /**
   * Vendor slug — lowercase alphanumeric with internal hyphens. Appears as a
   * path segment in the minted URL and is sealed into the token, so the two are
   * cross-checked on every delivery. Operator-facing: it is what makes a log
   * line and a vendor dashboard legible against each other.
   */
  vendor: string;
  /**
   * Absolute path ON THIS SERVER that the delivery is forwarded to, e.g.
   * `/ingest/emailbison`. Resolved against the connector's own base URL, and
   * validated to stay there — see `assertForwardablePath`.
   */
  route: string;
  /**
   * Name of a tool on this same server that accepts `{vendor, url}` and stores
   * the URL / registers it with the vendor. Must exist on the server's tool
   * list at install time, with those two string properties, or the install is
   * refused: a stream whose registration tool is missing or mis-shaped would
   * fail at first delivery instead — months later, at a vendor nobody is
   * watching.
   */
  register_tool: string;
  /** Human-readable summary of what this stream carries. Operator-facing only —
   *  the runtime never acts on it. */
  description?: string;
  /**
   * Rename one inbound header before the forward, as `{from: to}`.
   *
   * The forward strips the header class a caller could use to impersonate
   * identity (the same list the edge strips). A vendor that authenticates its
   * deliveries on a header in that class — `Authorization`, `X-Api-Key` — would
   * otherwise never reach its own verifier, and no replay could restore what
   * never arrived. Declaring a rename moves that value to a header the strip
   * list does not cover, so the server can verify it.
   *
   * Deliberately a header-name map and nothing else: it renames, it does not
   * interpret. Values are never read here.
   */
  header_renames?: Record<string, string>;
}

/**
 * The runtime's record of one minted stream, per `(workspace, connector, vendor)`.
 *
 * Note what this is NOT: a delivery log, a vendor registry, or a copy of the
 * declaration. It is the **revocation record** — the current `kid` and the one
 * it replaced — plus the forward target that was minted alongside it. The
 * runtime holds no token, ever; a token is reconstructible from the key, and
 * reconstructing one would put a live bearer capability wherever the caller
 * puts the result.
 *
 * `kid` is where a rotation becomes real: the door admits `kid` or `prevKid`
 * within the grace window and nothing else, so retiring a leaked URL is a write
 * to this record and takes effect on the next request. That is also why the
 * token carries no `exp` — an expiry can only ever fire late and silently,
 * whereas this check runs on every delivery.
 */
export interface HookRegistration {
  /** Slugified server name of the connector that declared the stream. */
  connector: string;
  /** Vendor slug from the declaration. */
  vendor: string;
  /** Current key id. The door admits a token bearing this one. */
  kid: string;
  /**
   * The `kid` this one replaced. Stays admissible for {@link HOOK_ROTATION_GRACE_MS}
   * so a vendor's in-flight redeliveries — queued against the old URL before it
   * re-registered — still land rather than being dropped as forgeries.
   */
  prevKid?: string;
  /** ISO timestamp of the rotation that produced `kid`. Absent before the first. */
  rotatedAt?: string;
  /** ISO timestamp of the first mint for this `(connector, vendor)`. */
  createdAt: string;
  /**
   * Forward target path, recorded from the declaration at mint time.
   *
   * Recorded rather than re-read live because the door must not depend on the
   * connector's subprocess being up to route a delivery, and because the URL
   * and the target it points at were minted together — splitting them across
   * two sources is how they drift. Refreshed on every install and rotation.
   */
  route: string;
  /** Header renames from the declaration, recorded with the route for the same reason. */
  headerRenames?: Record<string, string>;
}

/**
 * How long a rotated-out `kid` keeps working.
 *
 * Sized to the delivery retry window vendors typically offer (~24 h): a
 * redelivery queued against the old URL has to be able to land, or a rotation
 * silently drops whatever was in flight across it. Longer would leave a
 * retired capability live for no benefit; shorter turns routine rotation into
 * an event with data loss, which is how a control stops being used.
 */
export const HOOK_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
