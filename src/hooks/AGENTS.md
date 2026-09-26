# Inbound webhooks

Scope: the hooks door, `src/hooks/` and `src/api/routes/hooks.ts`. `clientAddressFor` is in `src/api/AGENTS.md`.

## Inbound Webhooks — the hooks door

`POST /v1/hooks/:deliveryId` (`src/api/routes/hooks.ts`, backed by
`src/hooks/`). One generic door for vendor deliveries that cannot carry a platform
token. The runtime opens the capability in the path, mints its ordinary
workspace-scoped platform token, and forwards the bytes to a route the connector
declared. Servers opt in with `_meta["ai.nimblebrain/host"].hooks` (`host_version: "1.2"`).

**The invariant: the runtime never parses a hook body.** It holds no vendor list
and no envelope knowledge. If you find yourself reading a field out of a
delivery, stop — that logic belongs in the receiving server's adapter, and the
split this door exists to maintain has failed.

Three more rules that are load-bearing, not stylistic:

- **The handler stays thin.** Open, check, mint, forward. No queue, no
  persistence, no retry. A tenant runtime is one pod, so a delivery arriving
  while it is busy costs the vendor a retry — the door must never be the reason
  it is busy. Durability belongs to the vendor's retry and the receiving
  connector's raw capture, both of which can provide it.
- **Every rejection is the same bare 404.** An id matching no registration, one
  whose grace window has closed, one whose workspace is gone, a registration too
  old to carry an id, an uninstalled connector — one path, one answer, no body.
  Anything that distinguishes them is an oracle a prober walks. `admitDelivery`
  returns `undefined` for all of them precisely so the caller has nothing to
  branch on — including the too-old case, which must never throw: the door scans
  every workspace, so one stale record raising would answer **500** for
  deliveries belonging to workspaces that are entirely current.
- **No agent-facing surface, and one operator-authored path out.** Nothing mints
  or rotates a hook from a tool the model can reach.
  `hooks__list_webhooks` / `hooks__rotate_webhook` carry
  `INTERNAL_TOOL_ANNOTATION` — stripped from the chat tool list and from
  `tools/list`, reached by the web shell's Webhooks settings tab.
  A path from a delivery to an agent run now exists, and its bounds are what
  make it safe rather than its absence: it runs only through a delivery route a
  workspace **admin** wrote, two durable hops from the door (the door writes to
  a connector's own store; the runtime polls that store into a workspace inbox;
  a route matches an inbox item), only into an automation whose own schedule
  asked for those notifications, batched, and capped by a fires-per-hour ceiling
  that disables the automation rather than throttling it. A delivery still
  reaches nothing on its own, which is the property this rule was protecting.

**The URL's secret is an opaque delivery id** — 256 bits of randomness, and the
whole capability. It names one registration; the connector, vendor and route are
read back from that record rather than restated in the path. Nothing is sealed
and nothing is MAC'd, which is why the URL is ~96 characters and fits a vendor's
255-character column, the constraint that killed the sealed-payload design.

The id is **stored as it is, not as a digest**, and that is deliberate: a
delivery URL is an ADDRESS handed to external systems repeatedly, so an admin
has to be able to read it. Under a digest the only way to see one is to rotate,
and looking would break the integration being looked at. The record already sits
beside that workspace's conversations and files, which this runtime does not
encrypt at rest, and its connector credentials, which it seals only when the
deployment configures sealing. What bounds it instead is that reading
needs workspace admin and rotating is one action. The door compares in constant
time — not because a timing oracle is practical against 256 bits behind a
per-source rate limit, but because that comparison is the only thing between a
guess and a forward.

There is **no expiry**. A vendor holds a URL for months, so retirement is the
lookup, which runs on every delivery and is effective immediately, rather than a
clock that can only fire late.

**The key** is `NB_HOOK_TOKEN_KEY`, a per-tenant secret. It no longer seals or
opens anything — it is the **switch deciding whether the door mounts at all**.
**Absent key ⇒ nothing is mounted** and the whole prefix 404s at the router, so
a local checkout gains no surface. The comma-separated ring it accepts is still
parsed and validated at boot (base64 round-trip, minimum length, placeholder
patterns, at most three entries) so an existing multi-key deployment keeps
booting, but the entries beyond the first now decide nothing. A leaked key used
to compromise every URL for the tenant; there is now no key to leak, and each
URL stands alone — revoked by rotating its own record, not by rotating a secret
that governs all of them.

**Registrations** live on the workspace record (`Workspace.hooks`), beside
`oauthOperatorApps`. They hold the current and previous delivery id, the `kid`,
and the route. The `kid` is **correlation only** — it is what the runtime's log
line names so an operator can line a delivery up against the URL it arrived on;
the door never admits on it. The delivery id is never logged, because unlike a
`kid` it IS a working URL.

**Rotation** (`hooks__rotate_webhook { connector, vendor }`, workspace admin):
mints a fresh id, keeps the outgoing one admissible for 24 h so in-flight
redeliveries land, and calls the server's `register_tool` with the new URL. It
**refuses when nothing was provisioned** — a connector that is not running
cannot be handed a URL, and reporting a rotation that did not happen is worst
exactly when this control is reached, which is after a URL has leaked. Cheap
and routine otherwise: a control nobody reaches for because it loses data is
not a control.

**`hooks__list_webhooks` returns the address**, with which connector and route it
feeds and whether the previous URL is still admissible — derived from
`isPreviousStillValid`, the same window the door enforces, because two copies of
that rule is how a settings page comes to promise an admin a URL still works
after the door stopped taking it.

**Provisioning is a reconcile, not an install step.** `ensureHooks` runs when a
connection reaches `running` (`setConnectionRunningObserver`), which covers a
fresh install, a boot, and an interactive OAuth flow completing long after the
install returned — one path instead of three that drift. It provisions only
what is missing, and **missing means unaddressable**: a registration with no
`deliveryId` is refused by the door, so it counts as missing and the next pass
gives it an address rather than skipping it. A declared `register_tool` that is
missing or does not accept `{vendor, url}` **provisions nothing** and is reported
as a warning on the install, which has already committed, and re-logged on every
transition to `running`. A `register_tool` call that merely errors leaves the
registration recorded (the connector is useful without its webhook, and a
rotation or reinstall retries).

**The forward adds no header, and the `kid` does not travel.** The fleet edge
strips the reserved `x-nb-*` namespace by RULE (it cannot tell a runtime-stamped
member from a caller-forged one — this forward arrives under an ordinary
`aud=mcp-fleet` token like any other call), so a stamped `X-NB-Hook-Kid` would
be dropped one hop later, reach nothing, and read as a broken pipeline whose
obvious repair is a hole in that rule. Kid correlation lives in the runtime's
delivery log line, which is the only place it appears — do not "restore" the
header. `isStrippedRequestHeader` mirrors the edge's rule (`x-user-id` plus the
`x-nb-*` prefix) rather than listing names, because the runtime sits AHEAD of
the edge and the namespace invariant only holds if every hop ahead of it also
refuses to pass one through. The general path stays a denylist: vendor signature
headers the runtime cannot enumerate have to reach the receiving verifier.
