# Web design standards

Rules for authoring UI in `web/`. Rules that govern a single selector live as
comments beside that selector in `index.css` — this file holds the ones that span
files, which is to say the ones you need *before* you write the component.

## Where values come from

`src/theme/palette.ts` is canonical. It generates `src/theme/tokens.generated.css`
(the `:root` / `.dark` blocks) via `bun run gen:theme`. Never edit the generated
file, and never edit a token value anywhere downstream.

`check:theme` runs in `verify:static`, and it is worth knowing exactly what it
does: it regenerates the CSS and fails if the committed output differs. It is a
**freshness guard on the generation step**. It does not scan components, so
nothing mechanically stops a hardcoded colour from entering a `.tsx` file.

That gap is currently occupied. `components/UserMenu.tsx` carries a six-colour
avatar palette as hex pairs, outside the token system and governed by nothing. It
is the standing example of what this rule is trying to prevent, not a precedent to
follow.

## Type

Three faces, each with one job:

| Face | Used for |
|---|---|
| Hanken Grotesk | Display and UI. There is no separate heading face — a heading is Hanken larger and heavier. |
| Newsreader | Agent prose in chat. Nowhere else. |
| JetBrains Mono | Code and monospace accents. |

Chat is the one surface in the product built for **reading**, which is why the
serif appears there and only there. A serif anywhere else reads as decoration.

## The opacity ramp

The canonical opacity modifiers for colour utilities (the `/N` suffix on `text-`,
`bg-`, and `border-`). Six steps. Pick by intent, and don't invent values in
between — no `/55`, `/70`, `/8`.

| Step | Intent |
|---|---|
| `/5` | Passive hover, resting subtle fill (nav rows, search box at rest) |
| `/10` | Active or selected fill, stronger hover for a discrete control |
| `/20` | Soft border (foreground / sidebar-foreground), faint surface (muted header strips) |
| `/50` | Faint text (placeholder, disabled), default muted surface (muted cards) |
| `/60` | Muted or secondary text, softened border token (`border-border`) |
| `/80` | Emphasized text, primary action hover (`bg-primary`) |

Two pairs are deliberately close and must stay distinct: `/5` vs `/10` (passive
versus control fill), and `/20` vs `/50` (faint versus default muted surface).

shadcn primitives under `components/ui/*` keep their vendored values.

## Chat chrome is ambient until it has something to say

Chrome follows cognitive weight. An element not conveying live information reads
as muted text beside the content, not as a box.

**Use the `.disclosure` primitive.** It already carries the behaviour: text-only
head at rest, box treatment only on `data-expanded="true"`, brand colour on the
leading dot only once active. A new collapsible chat surface should compose it
rather than re-derive at-rest opacity values. The rules live with it in
`index.css`; the tone axis that layers on top is documented at `.turn-pill`.

The bar is stricter than it sounds. Consolidating six status surfaces into a
single activity pill was still judged too loud at rest — one well-designed element
was too visually present. If you are adding chrome so the user knows a thing
exists, that is the signal to make it quieter, not louder.

## Main-area views are not viewport-width

Routed views under `/w/:slug/...` render in the main-area slot **left of the
docked chat**. Their width is that chat-adjacent column, which shrinks as the chat
docks or the window narrows. It is not the viewport.

Lay them out single-column, or with `@container` queries. Never viewport `md:` /
`lg:` breakpoints — a viewport breakpoint lies about the slot's real width, and a
two-pane master/detail collapses into nested unreadable scroll regions the moment
the chat is docked. Reference: `pages/ContextInspectorPage.tsx`, one scrolling
column with each layer's body expanding in place.

## Motion

Reveal motion is gated on `prefers-reduced-motion`. Anything new that animates
follows the same gate.
