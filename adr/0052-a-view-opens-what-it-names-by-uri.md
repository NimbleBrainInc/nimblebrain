# 0052. A view opens what it names by URI, and the host finds who shows it

- Status: Accepted
- Date: 2026-10-13
- Serves: orchestrate remote MCP

## Context

An app's view, and the agent, regularly need to take the person somewhere: to
a file the view lists, a conversation, another view of the same app, a record
the agent just found. Each of those places already has an address. MCP names
everything a server serves with a resource URI, a server advertises the URI
shapes it serves as resource templates (`resources/templates/list`), which
the agent already reads records by (ADR-0049), an app's
own screen is its `ui://` resource, and a view already reports where it is as
resource URIs in its trail (`ai.nimblebrain/location`), which the host hands
back as `ai.nimblebrain/navigate` when the person picks one.

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
names what it wants shown; the host decides what shows it. The host declares
the method in `hostCapabilities.experimental` (ADR-0024), and answers `{}` once
the place is on screen or an error naming the URI when nothing here shows it.

**The host resolves the URI by ownership, in this order, and never by trying
reads:**

1. **Kernel addresses.** A scheme the kernel owns and shows itself opens in
   the kernel's own surface. `conversation://<id>` is one: a conversation is
   kernel state, and it opens in the chat panel. Each such scheme is recorded
   in `src/tools/resource-schemes.ts`, which the build already holds complete.
2. **An app's own screen.** An app's `ui://` resource opens that app at its
   home.
3. **A served resource.** Otherwise the URI goes to the one app in the
   workspace that has a screen and advertises a resource template matching it.
   The app opens and receives the URI as `ai.nimblebrain/navigate`. A scheme
   the kernel resolves for reading, such as `files://`, is opened by the
   platform app that serves it, which advertises the template like any other
   app.

No match, or more than one, is refused with the URI in the error. Two servers
claiming one URI shape is a workspace defect for an operator to fix, not a tie
for the host to break.

**The agent opens through the same resolver.** `nb__open_app` takes a URI, or
an app's name, which the host turns into that app's `ui://` root. Opening a
record no longer asks the model which app shows it.

**Opening one's own connector settings is a separate request,
`ai.nimblebrain/open-connector-settings`, with no parameters.** The host
resolves the connector from the view that sent it, so a view can open only its
own settings. An address would let a view name another connector's, which is
the one thing this request must not allow.

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
- **Fold connector settings into `open` with a self-address**: rejected. The
  safety of that request is that it takes no address.
