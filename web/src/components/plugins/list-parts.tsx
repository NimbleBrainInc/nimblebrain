import { Menu } from "@base-ui/react/menu";
import { MoreHorizontal, Search } from "lucide-react";
import { Link } from "react-router-dom";
import type { Segment } from "../../lib/plugin-lists";
import { cn } from "../../lib/utils";
import { Tooltip } from "../ui/tooltip";

/**
 * The parts the Plugins and Skills pages share: the header, the Workspace |
 * Personal control with its search, and a row's ⋯ menu.
 *
 * Both pages render in the main area beside the docked chat, so their narrow
 * layout follows the `main` container, never the viewport (`web/DESIGN.md`).
 * Under 40rem (the gutter's own breakpoint) the header's action becomes an
 * icon button, the control and search stack full width, and every control is
 * at least 44px tall.
 */

/** A page's title and its one primary action. */
export function ListPageHeader({ title, action }: { title: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3" data-testid="list-page-header">
      <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
      {action}
    </div>
  );
}

/**
 * The header's action: its label beside its icon on a wide column, the icon
 * alone on a narrow one, named by `aria-label` at every width.
 */
export const HEADER_ACTION =
  "shrink-0 @max-[40rem]/main:size-11 @max-[40rem]/main:px-0 [&_svg]:size-4";
export const HEADER_ACTION_LABEL = "@max-[40rem]/main:sr-only";

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "personal", label: "Personal" },
];

/** Workspace | Personal with each one's count, and a search beside it. */
export function SegmentBar({
  segment,
  onSegment,
  counts,
  query,
  onQuery,
  searchLabel,
}: {
  segment: Segment;
  onSegment: (next: Segment) => void;
  counts: Record<Segment, number>;
  query: string;
  onQuery: (next: string) => void;
  /** The search's placeholder and accessible name: "Search plugins". */
  searchLabel: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 @min-[40rem]/main:flex-row @min-[40rem]/main:items-center"
      data-testid="segment-bar"
    >
      <fieldset
        aria-label="Whose"
        className="grid shrink-0 grid-cols-2 rounded-sm bg-foreground/5 p-0.5 @min-[40rem]/main:inline-grid"
        data-testid="segment"
      >
        {SEGMENTS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={segment === id}
            onClick={() => onSegment(id)}
            data-segment={id}
            className={cn(
              "flex min-h-11 items-center justify-center rounded-xs px-3 text-sm transition-colors @min-[40rem]/main:min-h-7 @min-[40rem]/main:text-xs",
              segment === id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            <span className="ml-1.5 text-muted-foreground tabular-nums" data-testid="segment-count">
              {counts[id]}
            </span>
          </button>
        ))}
      </fieldset>
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{searchLabel}</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) onQuery("");
          }}
          placeholder={searchLabel}
          data-testid="list-search"
          className="h-11 w-full rounded-sm border border-transparent bg-foreground/5 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 @min-[40rem]/main:h-8"
        />
      </label>
    </div>
  );
}

/** What a list says when its segment or search leaves nothing. */
export function ListEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground" data-testid="list-empty">
      {children}
    </p>
  );
}

/**
 * The link that opens a row's page, stretched over the whole row; a row's
 * controls sit above it (`relative`), beside the link rather than inside it,
 * because a control cannot nest inside a link.
 */
export const ROW_LINK =
  "outline-none after:absolute after:inset-y-0 after:-inset-x-1 after:rounded-sm after:transition-colors hover:after:bg-foreground/5 focus-visible:after:ring-2 focus-visible:after:ring-ring";

/**
 * A row's name and its line beneath or beside it: one line on a wide column,
 * two on a narrow one.
 */
export const ROW_TEXT =
  "flex min-w-0 flex-1 flex-col @min-[40rem]/main:flex-row @min-[40rem]/main:items-baseline @min-[40rem]/main:gap-2.5";

/** An item in a row's ⋯ menu: a link, or an action. */
export type RowMenuItem =
  | { kind: "link"; label: string; to: string }
  | { kind: "action"; label: string; onSelect: () => void; destructive?: boolean };

export function RowMenu({
  name,
  items,
  testId,
}: {
  name: string;
  items: RowMenuItem[];
  /** `plugin-menu` or `skill-menu`; the popup adds `-popup`. */
  testId: string;
}) {
  const itemClass =
    "flex w-full cursor-default items-center px-3 py-1.5 text-sm outline-none data-[highlighted]:bg-foreground/5 data-[disabled]:opacity-50";
  return (
    <Menu.Root>
      <Tooltip label="More actions" side="left">
        <Menu.Trigger
          aria-label={`${name} actions`}
          data-testid={testId}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[popup-open]:bg-foreground/10 @min-[40rem]/main:size-7"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            data-testid={`${testId}-popup`}
            className="min-w-44 rounded-sm border bg-popover py-1 text-popover-foreground shadow-md outline-none"
          >
            {items.map((item) =>
              item.kind === "link" ? (
                <Menu.LinkItem
                  key={item.label}
                  closeOnClick
                  render={<Link to={item.to} />}
                  className={itemClass}
                >
                  {item.label}
                </Menu.LinkItem>
              ) : (
                <Menu.Item
                  key={item.label}
                  className={cn(itemClass, item.destructive && "text-destructive")}
                  onClick={item.onSelect}
                >
                  {item.label}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * A section of a plugin's or skill's page whose heading sits beside its action
 * on a wide column. On a narrow one they stack and the action takes the full
 * width (`SECTION_ACTION`).
 */
export const SECTION_ROW =
  "flex flex-col gap-3 @min-[40rem]/main:flex-row @min-[40rem]/main:items-start @min-[40rem]/main:justify-between @min-[40rem]/main:gap-4";
export const SECTION_ACTION = "w-full @max-[40rem]/main:h-11 @min-[40rem]/main:w-auto";
