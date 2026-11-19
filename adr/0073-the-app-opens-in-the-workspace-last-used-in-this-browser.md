# 0073. The app opens in the workspace last used in this browser

- Status: Proposed
- Date: 2026-11-19
- Serves: secure RBAC
- Supersedes: [ADR-0060](./0060-a-viewer-may-choose-the-workspace-the-app-opens-in.md)
- Amends: [ADR-0044](./0044-the-url-is-the-only-thing-that-names-a-workspace.md) (where `/` sends a user in several workspaces)

## Context

The runtime walls every session to exactly one workspace, and the web shell
is in a workspace on every `/w/<id>` page. ADR-0044 gave `/` a page of its own
for a user in several workspaces: a grid of them. ADR-0060 let a viewer skip
the grid by choosing a default workspace, and kept the grid one click away
from inside the app (the logo, the palette's Home, the switcher's "All
workspaces"), because the grid was where the default was changed.

The grid is the one place in the shell that is in no workspace, so every link
to it takes the viewer out of their workspace onto a page whose sidebar has no
nav. Every job it does is done elsewhere: the sidebar's workspace switcher
lists every workspace behind a filter, marks each one with unread
notifications, holds the default toggle, and creates a workspace. Pinning, the
grid's only job of its own, orders only the grid. What the grid uniquely
answers is one question, asked once per load: which workspace to open.

## Decision

**`/` is not a page. It opens the workspace this browser was last in**, while
the viewer is still a member of it, and otherwise the first workspace in the
switcher's order. A viewer in no workspace, which bootstrap prevents but
leaving or losing every workspace can produce, is offered a new one.

**The last workspace is a per-browser preference, written when a `/w/<id>`
page focuses a workspace the viewer belongs to** and read in one place, the
redirect at `/`, to choose which `/w/<id>` URL to open. Nothing reads it to
scope a request: the URL is still the only thing that names a workspace, and
the server still chooses none.

**Every link to `/` lands in a workspace.** The logo, the palette's overview
action, a bounce from a workspace the viewer cannot reach, and leaving a
workspace all go to `/`, so they open the workspace the viewer is in (or was
last in). The bounce says why the address did not open.

**A way out never goes through `/` when the last workspace may be what
failed.** The mid-session recovery from a rejected workspace opens its
fallback by its own address, and the page shown for a failed render lists the
viewer's other workspaces by theirs, so a workspace that fails cannot trap the
viewer in a loop back to itself.

**The default workspace, the home grid, and pinned workspaces are removed.**
The last workspace is the default, kept without a control. The switcher keeps
the focused workspace's settings and "New workspace".

## Consequences

- A viewer who works in one workspace and opens the app lands in it on every
  load, with nothing to set. One who moves between workspaces lands where they
  left off.
- A fresh browser opens the first workspace in the switcher's order, which the
  viewer did not pick. The switcher names it, and switching is one click.
- The `nb:default-workspace` and `nb:pinned-workspaces` keys are no longer read.
  A browser that had a default opens the first workspace once, and from then on
  the last one.
- Unread marks for other workspaces are on the switcher's rows and its trigger,
  as ADR-0060 already relied on.

## Alternatives considered

- **Keep the grid as a chooser shown only when `/` cannot resolve** — rejected:
  with a last workspace and a fallback, `/` always resolves, so the chooser
  would be a page that only a fresh browser in several workspaces ever sees,
  to make a choice the switcher makes in one click.
- **Keep the chosen default beside the last workspace** — rejected: two
  answers to "where do I open" that disagree as soon as the viewer works
  somewhere else, and the chosen one costs a control to keep right.
- **ADR-0060's objection to a remembered last workspace: "a workspace the
  viewer did not choose to open in, and it changes as they move between
  them"** — answered: the viewer chose it by working there, and changing as
  they move is what makes it the right place to reopen. A default stays put
  while their work moves on.
- **Remember the last workspace on the server** — rejected for ADR-0044's
  reason: a server-held answer to a question the URL answers, which would
  follow the viewer onto every device.
