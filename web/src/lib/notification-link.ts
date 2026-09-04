import type { PlacementEntry } from "../types";

/**
 * Where a notification's `link.resource` goes in this shell, or `null`.
 *
 * A connector chooses this URI and the runtime resolves nothing from it — the
 * envelope's whole contract is that the host reads the standard fields and its
 * own `_meta` block, not that it understands a server's namespace. So the rule
 * here is the narrow one: render an affordance only where the shell has
 * somewhere to send the click, which means a `ui://` resource that matches a
 * placement the focused workspace actually mounts. Everything else — the
 * server's own scheme (`acme://campaigns/…`), a scheme nothing mounts, an
 * `https://` URL — renders as text.
 *
 * `https://` is text on purpose, not by omission. `title`, `body` and this URI
 * are server-authored strings that reach a human's attention surface; turning
 * one into a clickable external link would make the inbox a delivery vehicle
 * for whatever address a connector felt like emitting. An operator who wants to
 * follow one can still read it and decide.
 */
export function resolveNotificationLink(
  uri: string,
  placements: readonly PlacementEntry[],
  slug: string | undefined,
): string | null {
  if (!slug || !uri.startsWith("ui://")) return null;
  const match = placements.find((p) => p.resourceUri === uri && p.route);
  return match?.route ? `/w/${slug}/app/${match.route}` : null;
}
