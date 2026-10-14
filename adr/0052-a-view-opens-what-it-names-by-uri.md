# 0052. A view opens what it names by URI, and the host finds who shows it

- Status: Accepted
- Date: 2026-10-13
- Serves: orchestrate remote MCP

## Context

An app's view, and the agent, regularly need to take the person somewhere: to
a file the view lists, a conversation, another view of the same app, a record
the agent just found. Most of those places already have an address. MCP names
everything a server serves with a resource URI, and a server can advertise the
URI shapes it serves as resource templates (`resources/templates/list`), as the
agent already relies on to read records
([ADR-0049](./0049-the-agent-reads-a-connectors-records-as-resources.md)). An
app's own screen is its `ui://` resource, and a view reports where it is as
resource URIs in its trail (`ai.nimblebrain/location`), which the host hands
back as `ai.nimblebrain/navigate` when the person picks one. A conversation has
no address yet; this decision gives it one.

What a view lacks is a way to ask for one of those addresses. A request named
per kind of place (open an app, open a conversation, open a file) grows a
method, a declared capability and a client release with every kind, and an
"open an app" request makes the caller name the app that shows the place. That
is one connector naming another: the caller has to know which server owns a
scheme it does not own, and the knowledge breaks when the workspace installs a
different server in that slot. The agent's `nb__open_app` has the same shape,
an app name plus a target, so the model has to know the owner too.

A move the host makes on a view's behalf is also an answer the view needs. A
fire-and-forget request leaves a view that asked for something the workspace
cannot show with nothing to tell the person.

## Decision

**One request opens anything: `ai.nimblebrain/open` with `{ uri }`.** A view
names what it wants shown; the host decides what shows it. The method is named
under the private namespace (ADR-0024) and declared in
`hostCapabilities.experimental`, as every NimbleBrain extension is
(`web/src/bridge/extensions.ts`).

**The answer says what the host did, not what the app did.** `{}` means the
host found what shows the URI, put it on screen, and handed it the URI. Whether
an app then shows that view is the app's: `ai.nimblebrain/navigate` expects no
reply, and reaches an app only after its first location report. A view that
needs to know learns it the way the host does, from the app's next trail. An
error names the URI when nothing here shows it.

**The host resolves the URI by ownership, in this order, and never by trying
reads:**

1. **Kernel surfaces.** A scheme the shell shows in its own chrome, rather
   than in an app, opens there. It is a set of its own, kept beside the
   resolver: the schemes in `src/tools/resource-schemes.ts` are every scheme
   the host resolves, and the kernel-shown set is the subset it shows in its
   own chrome. This decision adds `conversation://<id>`, which opens the chat
   panel. The host answers it, so it joins `RESERVED_RESOURCE_SCHEMES`, where
   no declared resource can claim it.
2. **An app's own screen.** An app's `ui://` resource opens that app at its
   home.
3. **A served resource.** Otherwise the URI goes to the one app the person can
   open that advertises a resource template matching it: the workspace's apps
   with a screen, and the kernel's own per-person apps (`IDENTITY_SOURCES`),
   which sit in no workspace registry. A template matches when the URI is one
   of its expansions (RFC 6570). The app opens and is handed the URI as
   `ai.nimblebrain/navigate`. Files are reached this way: the Files app
   advertises `files://{id}` like any other app.

`artifact://` opens nothing. An artifact renders inline in the conversation
that produced it and has no screen of its own, so `open` refuses it until
something shows artifacts and advertises their shape.

No match, or more than one, is refused with the URI in the error. Two servers
claiming one URI shape is a workspace defect for an operator to fix, not a tie
for the host to break.

**The agent opens through the same resolver.** `nb__open_app` takes a URI, or
an app's name, which the host turns into that app's `ui://` root. Opening a
record no longer asks the model which app shows it.

**Opening one's own connector settings is a separate request,
`ai.nimblebrain/open-connector-settings`, with no parameters.** The host
resolves the connector from the view that sent it. "My settings" is not an
address: a URI names the same place whoever holds it, which is what lets a
view, the agent, a trail or a link pass one along, and this request means a
different page for every sender. The settings page of a named connector would
be an address, but a view cannot spell it, because a connector's id is the
host's own naming and nothing hands it to the view. When more host pages need
opening from a view, they get kernel-shown schemes and the host publishes
each view's own addresses; this request then folds into `open`.

**Both requests replace `ai.nimblebrain/action`.** The SDK exposes them as
`open(app, uri)` and `openConnectorSettings(app)` with `useOpen` and
`useOpenConnectorSettings`: each resolves `true` once done, `false` without
sending on a host that did not declare it, and rejects with the host's error on
a refusal, as `notify` does.

## Consequences

- A new kind of openable place is a URI scheme its owner serves, with a
  template. It needs no host method, no capability and no SDK release.
- A view never names another app. Replacing the server that shows a scheme
  changes what opens, not the code that asked.
- An app's records become openable by the agent, by other views and by deep
  links only when its server advertises their URI shape as a template. That
  declaration is the spec's own, and an app that does not make it still opens
  at its home by name.
- Opening grants nothing. The opened app reads its own data under its own
  grants, so a view can move the person's screen, as it could before, but
  cannot read anything through `open`.
- Discovery is the method, not a list: what resolves depends on what the
  workspace has installed, and a list in the handshake would go stale. A view
  learns that a URI does not open from the refusal.
- The request is a candidate for MCP Apps as it stands: one action over the
  spec's own addresses, the same shape as `ui/open-link` over the web's.
  Standardizing it is a rename (ADR-0024).
- A deep link into the shell is a route over the same resolver, added when
  something needs it.
- `ai.nimblebrain/action` is served for one release beside the new requests,
  then removed. Platform apps in this repo move in the release that adds
  `open`, but a connector's bundle ships on its own schedule. A bundle built
  against an older SDK fails silently once the host stops declaring the
  method: its `action()` finds no declaration and sends nothing. The overlap
  release gives such a bundle time to rebuild against the new requests.

## Alternatives considered

- **One request per kind of place** (`open-app`, `open-conversation`, …):
  rejected. Each new kind costs a method, a capability and a release, and the
  app-shaped one makes a view name another app.
- **A generic `action { name, params }`**: rejected. Nothing is declared,
  nothing is answered, and the names are a private vocabulary no other host
  can implement.
- **Resolve by reading the URI from each server until one answers**:
  rejected. It costs a read per server, triggers the server's side effects,
  and lets any server that answers loosely claim another's addresses.
- **Fold connector settings into `open` with a self-address**: rejected. A
  URI whose meaning depends on its sender cannot be passed along, which is
  the property `open` rests on.
- **Give each connector's settings a scheme now, and publish the view's own
  URI in the host context**: deferred. It is new host surface for a single
  caller; one parameterless request costs less until other host pages need
  the same.
