# 0060. A viewer may choose the workspace the app opens in

- Status: Accepted
- Date: 2026-11-09
- Serves: secure RBAC
- Amends: [ADR-0044](./0044-the-url-is-the-only-thing-that-names-a-workspace.md) (where `/` sends a user in several workspaces)

## Context

ADR-0044 sends a user in exactly one workspace from `/` into it, and shows
anyone else the home grid. Someone in many workspaces who works in one of them
most days pays a click on every load to get past a grid they did not need.
Pinning only orders the grid; it does not open anything.

ADR-0044 rejected a workspace the server or the shell picks: one the user did
not choose, held as ambient state beside the URL. It deferred a browser-held
last workspace because it would skip the grid's unread marks. A default the
viewer picks is neither: the viewer chose it, and every workspace's unread mark
is also on its row in the sidebar's workspace switcher, which marks its own
trigger when another workspace has unread.

## Decision

**A viewer may choose one default workspace, per browser, from the home grid.**
It is a browser preference beside pinned workspaces: never sent to the server,
never written by the shell on its own. Choosing another workspace replaces it;
choosing it again clears it. It is separate from pinning, so ordering the grid
never changes where the viewer lands.

**`/` opens the default only when the page loads there.** A load at `/`
(typing the address, a bookmark, a fresh tab, signing in) goes to the default
workspace's `/w/<id>/`. A link to `/` from inside the app (the logo, the
palette's Home, a bounce from a workspace the viewer cannot reach) shows the
grid, so the grid, and the control that changes the default, stays one click
away. `/?home` is a load that shows the grid regardless; a link that reloads the
page to escape a failing render uses it, so a failing default workspace cannot
trap the viewer.

**The default opens only while the viewer is a member.** It is checked against
the workspaces bootstrap returned, so a workspace the viewer has left or lost
is ignored and the grid shows.

**The URL still names the workspace.** The default only chooses which `/w/<id>`
URL a load at `/` goes to; nothing reads it to scope a request, and the server
chooses no workspace.

## Consequences

- A user in several workspaces who chose a default opens into it on that
  browser; on another browser they see the grid until they choose there too.
- A user in one workspace still goes straight into it, whatever is stored.
- The home grid is reached from inside the app; landing on it is no longer the
  only place its unread marks are seen, which the switcher already covers.

## Alternatives considered

- **Hold the default on the server, in the profile** — rejected: it is the
  server-held default ADR-0044 removed, and a per-browser choice costs nothing
  when it is lost.
- **Make the first pinned workspace the default** — rejected: pinning sorts,
  and sorting a workspace to the top should not move where the app opens.
- **Redirect every visit to `/`** — rejected: the logo and the palette's Home
  would never reach the grid, and the grid is where the default is changed.
- **Remember the last workspace instead** — rejected: it is a workspace the
  viewer did not choose to open in, and it changes as they move between them.
