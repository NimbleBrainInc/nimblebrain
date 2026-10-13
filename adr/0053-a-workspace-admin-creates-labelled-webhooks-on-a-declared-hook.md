# 0053. A workspace admin creates labelled webhooks on a declared hook

- Status: Proposed
- Date: 2026-10-13
- Serves: orchestrate remote MCP, secure RBAC

## Context

The hooks door (ADR-0025, `src/hooks/`) gives a connector inbound delivery URLs.
A connector declares a hook in its host metadata; when the connection reaches
`running`, the runtime mints exactly one registration per
`(workspace, connector, vendor)` and hands the URL to the hook's
`register_tool`. The Webhooks settings tab lists those URLs and rotates them.
It cannot create one.

That serves a connector that owns its vendor feed: a campaign platform with one
webhook-URL field gets one URL, created when the connector is installed. It does
not serve a workspace admin who wants to push events from a system unrelated to
any installed app (a CRM, a billing system, a form builder, their own code) into
the workspace and route them to a tool or an agent run. A generic receiving
connector can accept those deliveries, but with one registration per workspace,
every sender shares one URL:

- **Revocation is all or nothing.** The URL is the capability. A URL leaked
  through one sender is rotated for every sender, and each one has to be
  reconfigured.
- **Senders cannot be told apart by credential.** Each sender that signs its
  deliveries signs with its own secret. Two signing senders on one URL cannot
  both verify against the one secret the receiver holds.

The runtime is the only component that may mint a delivery URL, because a
delivery URL decides which workspace a request belongs to (ADR-0025). So a
second URL that can be revoked on its own is a second registration, and only the
runtime can create it. A receiver that sorts deliveries from one URL by their
headers answers neither problem above.

## Decision

**A hook declaration is a template, and a workspace holds a list of its
registrations.** A hook whose `register_tool` accepts a `label` is *labelled*: a
workspace admin creates its registrations, up to ten per
`(workspace, connector, vendor)`. A hook whose `register_tool` does not accept
`label` is unchanged: the runtime mints exactly one registration when the
connection reaches `running`, as before. There is no flag. The capability is
read from the tool's advertised input schema, which `verifyRegisterTool` already
checks for `vendor` and `url`.

- **A connector creates its own hooks; an admin creates labelled ones.**
  - An unlabelled hook is a feed the connector owns, such as a vendor that holds
    one URL. It gets one registration, minted by the reconcile.
  - A labelled hook is a receiver. The reconcile mints nothing for it. Every
    registration on it is one an admin created, named, and can delete.
- **A label is a slug the admin chooses**, held to `HOOK_SLUG_RE` and unique
  within its `(workspace, connector, vendor)`. It names the registration in the
  Webhooks tab and in the runtime's delivery log line. It is not in the delivery
  URL, which stays an opaque delivery id.
- **The forward tells the connector which registration a delivery arrived on,
  through the path.** A labelled hook's `route` must contain the placeholder
  `{label}` exactly once, in a path segment (`/ingest/inbound/{label}`). The
  runtime substitutes the registration's label at mint time and records the
  resulting route on the registration, as it records the route today. The
  forward still adds no header (`src/hooks/AGENTS.md`). The label comes from the
  runtime's own record, never from the sender. A declaration that has
  `{label}` in its route while its `register_tool` takes no `label`, or the
  reverse, is a `HookContractError` and mints nothing.
- **`register_tool` is called with `{vendor, url, label}`** for a labelled
  registration: on creation and on every rotation. An unlabelled hook's call
  stays `{vendor, url}`.
- **Creating a registration is an admin action in the Webhooks tab**, through a
  `hooks__*` action with `ui.visibility: ["app"]`, like rotation. It is never a
  tool the model can reach. The tab offers it for every installed labelled hook.
  When the workspace has none, its empty state lists the catalog entries that
  declare a labelled hook and offers to install one. It selects by that
  capability, never by a connector's name.
- **A labelled hook may name a `configure_tool`.** The tab renders that tool's
  input schema as the registration's settings form and calls it, with `vendor`
  and `label`, as an admin app call. The schema must keep to the subset MCP
  defines for form-mode elicitation: a flat object of string, number, boolean,
  and enum properties. A property marked `writeOnly` is rendered as a secret
  input, never prefilled, and redacted from the audit line by the existing
  admin-tool audit (`auditArguments`, `src/permissions/admin-tools.ts`). The tool
  must be listed in the connector's `admin_tools`. Settings the connector
  stores, signing secrets included, are the connector's: the runtime renders the
  form and relays the call, and keeps nothing from it.
- **Deleting a registration deletes it.** The delivery id stops being admitted
  on the next request, with no grace window. Rotation keeps its 24-hour grace
  because in-flight redeliveries were sent to the outgoing URL. A delete is a
  decision to stop the sender. When the declaration names an
  `unregister_tool` that accepts `{vendor, label}`, the runtime calls it after
  the delete. A failed call is logged and does not restore the registration:
  the door has already stopped admitting the URL, which is the control.
- **The cap is policy, not configuration.** Ten registrations per labelled hook
  per workspace. Each one is a live credential held outside the platform, and a
  bound on them is a bound on what an admin has to track.

The rules that make the door safe are unchanged: the runtime never parses a
delivery body, every rejection is the same bare 404, a delivery id is 256 bits
of randomness and the whole capability, and nothing mints or rotates a URL from a
tool the model can reach.

## Consequences

- A workspace can take events from any system that can POST to a URL, one
  registration per sender, each revocable without touching the others, and route
  them to a tool or an agent run through the existing notification routes.
- A third-party receiver gets the same treatment by accepting `label` and
  carrying `{label}` in its route. The runtime holds nothing specific to the
  first-party receiver.
- Existing hooks are untouched. No connector declares a labelled hook until it
  ships a `register_tool` that accepts `label`, so the change lands without a
  data migration. A connector that converts an unlabelled hook to a labelled one
  owns moving its own existing registration; the runtime keeps any unlabelled
  registration it already holds addressable until an admin deletes it.
- The shell gains a small form renderer for the elicitation schema subset. It is
  the same subset a form-mode elicitation will need when the runtime answers one,
  so it is not single-use.
- Signing secrets for a labelled hook live in the receiving connector, entered
  through the settings form. The connector's own storage of them (sealed at
  rest, never returned) is its obligation, as it is for any credential a
  connector holds.
- The runtime's workspace record holds up to ten more registrations per labelled
  hook. They are small and already per-workspace.

## Alternatives considered

- **A `multi: true` flag on the declaration**: rejected. It is a second statement
  of something the `register_tool` schema already says. A flag that disagrees
  with the tool fails at a delivery; reading the capability from the tool fails
  at install, which is where ADR-0025 put every other check on this contract.
- **One URL per workspace, with the receiver sorting senders by header**:
  rejected. It cannot revoke one sender without the rest, and cannot hold a
  secret per signing sender. Both need a credential per sender, and the
  credential is the URL.
- **One event endpoint and a router, such as a cloud event bus routing
  CloudEvents**: rejected. Senders post their own body formats and cannot be made
  to send CloudEvents attributes, so something must translate each format, and
  the runtime never reads a body. Each sender still needs its own credential to
  bind a delivery to a workspace, which returns to one registration per sender.
  Routing by event name already exists in the notification routes (ADR-0008).
  An external bus would also make a self-hosted runtime depend on one cloud's
  service.
- **Tenant-mintable delivery URLs, or a connector minting its own**: rejected,
  for ADR-0025's reason. A URL decides which workspace a request belongs to, so
  only the runtime mints one, and only for a hook an operator-trusted catalog
  entry declared.
- **Per-registration signing secrets in the runtime's credential store, applied
  as a header on the forward**: rejected. It scopes runtime credentials to a
  connector's sub-resource, and the secret would reach the connector only on a
  forward. A connector that re-verifies a stored delivery after its settings are
  corrected needs the secret on a tool call, which a per-registration header
  cannot reach. The receiver is the only reader of the secret, so it holds it.
- **A grace window on delete**: rejected. A delete that keeps a URL working for a
  day does not do what an admin who deletes a leaked URL asked for. Rotation is
  the action that keeps the grace.
