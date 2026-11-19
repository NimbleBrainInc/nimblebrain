import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight, MoreHorizontal, Search, User, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Plugin } from "../../_generated/platform-schemas/plugins";
import type { AuthoredSkill } from "../../lib/authored-skills";
import {
  attentionReason,
  countLine,
  DEFAULT_COLLAPSED,
  type InstalledFilters,
  type InstalledItem,
  type InstalledModel,
  type ItemOwner,
  type KindFilter,
  type OwnerFilter,
  parseCollapsed,
  type SectionId,
  type SectionModel,
  SUBLIST_PREVIEW,
} from "../../lib/installed-view";
import { type LocalPref, usePref, writePref } from "../../lib/local-pref";
import { accountLine } from "../../lib/plugins";
import { skillMechanismLabel } from "../../lib/skill-display";
import { cn } from "../../lib/utils";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { Badge } from "../ui/badge";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";

/**
 * The Installed tab, laid out for a long listing: a toolbar (search, a kind
 * filter with counts, an owner filter), a Needs-you strip of the plugins whose
 * next step is an action, then the sections by who an item acts for, each
 * collapsible and each sub-list showing its first few rows until asked for
 * all. A search drops the sections for one list of matches.
 *
 * Presentational: the page loads the listing and owns every action, and hands
 * each plugin row its action and menu (`rowAction`, `rowMenu`). Rows inside a
 * section carry no owner mark, since the section says whose they are; a row
 * shown outside its section (Needs you, a search result) carries one on its
 * icon.
 */
export interface InstalledViewProps {
  model: InstalledModel;
  filters: InstalledFilters;
  onFiltersChange: (next: InstalledFilters) => void;
  workspaceName: string;
  /** Total plugins and skills installed, for the search's placeholder. */
  total: number;
  /** The plugin's page. */
  pluginTo: (plugin: Plugin) => string;
  /** The skill's page. */
  skillTo: (skill: AuthoredSkill) => string;
  /** What the row asks of the viewer, or nothing for a healthy plugin. */
  rowAction: (plugin: Plugin) => React.ReactNode;
  /** The row's ⋯ menu items. */
  rowMenu: (plugin: Plugin) => RowMenuItem[];
  /** Whether a sign-in on this page just connected this plugin. */
  justConnected: (plugin: Plugin) => boolean;
  /**
   * A control at the end of a skill's row, before its menu. The seam for
   * turning one of the viewer's own skills off in this workspace; nothing
   * passes one yet.
   */
  skillControl?: (skill: AuthoredSkill) => React.ReactNode;
  /** Shown when nothing is installed at all. */
  emptyState: React.ReactNode;
}

export function InstalledView(props: InstalledViewProps) {
  const { model, filters, onFiltersChange, workspaceName } = props;
  if (model.empty) return <>{props.emptyState}</>;

  return (
    <div className="space-y-5">
      <InstalledToolbar
        filters={filters}
        onChange={onFiltersChange}
        counts={model.counts}
        total={props.total}
      />

      {model.results ? (
        <SearchResults {...props} results={model.results} />
      ) : (
        <>
          {model.needsYou.length > 0 && <NeedsYou {...props} plugins={model.needsYou} />}
          {model.sections.length === 0 ? (
            <NoMatches />
          ) : (
            model.sections.map((section) => (
              <InstalledSection
                key={section.id}
                {...props}
                section={section}
                workspaceName={workspaceName}
              />
            ))
          )}
          <p className="text-xs text-muted-foreground">
            Skills that come with a plugin are on that plugin's page.
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "plugins", label: "Plugins" },
  { id: "skills", label: "Skills" },
];

function InstalledToolbar({
  filters,
  onChange,
  counts,
  total,
}: {
  filters: InstalledFilters;
  onChange: (next: InstalledFilters) => void;
  counts: InstalledModel["counts"];
  total: number;
}) {
  const countOf = (kind: KindFilter) =>
    kind === "plugins"
      ? counts.plugins
      : kind === "skills"
        ? counts.skills
        : counts.plugins + counts.skills;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-48 flex-1">
        <span className="sr-only">Search plugins and skills</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filters.query) onChange({ ...filters, query: "" });
          }}
          placeholder={`Search ${total} plugins and skills`}
          data-testid="installed-search"
          className="h-8 w-full rounded-sm border border-transparent bg-foreground/5 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <fieldset
        aria-label="Show"
        className="flex rounded-sm bg-foreground/5 p-0.5"
        data-testid="installed-kind"
      >
        {KINDS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={filters.kind === id}
            onClick={() => onChange({ ...filters, kind: id })}
            data-kind={id}
            className={cn(
              "rounded-xs px-2.5 py-1 text-xs transition-colors",
              filters.kind === id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            <span className="ml-1.5 text-muted-foreground tabular-nums">{countOf(id)}</span>
          </button>
        ))}
      </fieldset>
      <Select
        aria-label="Whose"
        value={filters.owner}
        onChange={(e) => onChange({ ...filters, owner: e.target.value as OwnerFilter })}
        className="w-auto"
        data-testid="installed-owner"
      >
        <option value="everyone">Everyone</option>
        <option value="shared">Shared</option>
        <option value="you">Just you</option>
      </Select>
    </div>
  );
}

function NoMatches() {
  return (
    <p
      className="py-6 text-center text-sm text-muted-foreground"
      data-testid="installed-no-matches"
    >
      Nothing matches. Try another search or filter.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Needs you, search results
// ---------------------------------------------------------------------------

/** A long Needs-you list shows its first few, then all on request, like a section's. */
function NeedsYou(props: InstalledViewProps & { plugins: Plugin[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? props.plugins : props.plugins.slice(0, SUBLIST_PREVIEW);
  return (
    <section
      className="rounded-md border border-warning/20 bg-warning/5 px-3 py-1"
      data-testid="installed-needs-you"
      aria-labelledby="installed-needs-you-title"
    >
      <h2 id="installed-needs-you-title" className="pt-2 pb-1 text-xs font-medium text-warning">
        Needs you · {props.plugins.length}
      </h2>
      <div className="divide-y divide-warning/20">
        {shown.map((plugin) => (
          <PluginRow
            key={plugin.id}
            {...props}
            plugin={plugin}
            ownerMark={plugin.owner.kind === "workspace" ? "shared" : "you"}
            meta={[
              ownerWord(plugin.owner.kind === "workspace" ? "shared" : "you"),
              attentionReason(plugin),
            ]
              .filter(Boolean)
              .join(" · ")}
            inset={false}
          />
        ))}
      </div>
      {props.plugins.length > SUBLIST_PREVIEW && (
        <ShowAllButton
          all={all}
          total={props.plugins.length}
          noun=""
          onToggle={() => setAll(!all)}
        />
      )}
    </section>
  );
}

function ShowAllButton({
  all,
  total,
  noun,
  onToggle,
  className,
}: {
  all: boolean;
  total: number;
  /** What is shown, after the count ("plugins"); none for a list of one kind already named. */
  noun: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={all}
      data-testid="installed-show-all"
      className={cn(
        "my-1 rounded-sm px-1 py-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {all ? "Show fewer" : `Show all ${total}${noun ? ` ${noun}` : ""}`}
    </button>
  );
}

function ownerWord(owner: ItemOwner): string {
  return owner === "shared" ? "Shared" : "Yours";
}

function SearchResults(props: InstalledViewProps & { results: InstalledItem[] }) {
  if (props.results.length === 0) return <NoMatches />;
  return (
    <section data-testid="installed-results" aria-label="Search results">
      <div className="border-t border-border">
        {props.results.map((item) =>
          item.kind === "plugin" ? (
            <PluginRow
              key={`p:${item.plugin.id}`}
              {...props}
              plugin={item.plugin}
              ownerMark={item.owner}
              inset={false}
            />
          ) : (
            <SkillRow
              key={`s:${item.skill.id}`}
              {...props}
              skill={item.skill}
              ownerMark={item.owner}
              inset={false}
            />
          ),
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** The viewer's collapse choices on this page, kept in their browser. */
const COLLAPSED_PREF: LocalPref<Partial<Record<SectionId, boolean>>> = {
  key: "nb:plugins:collapsed",
  parse: parseCollapsed,
  empty: {},
};

function sectionCopy(id: SectionId, workspaceName: string): { title: string; explain: string } {
  switch (id) {
    case "shared":
      return {
        title: `Shared in ${workspaceName}`,
        explain: "Everyone's agent here uses these. Plugins sign in with the workspace's accounts.",
      };
    case "you":
      return {
        title: "Just you",
        explain:
          "Only your agent uses these. Your plugins act where you turn them on; your skills follow you to every workspace.",
      };
    case "not-here":
      return {
        title: "Yours, not on here",
        explain: `Your plugins that are off in ${workspaceName}. Use here turns one on for your agent.`,
      };
  }
}

function InstalledSection(props: InstalledViewProps & { section: SectionModel }) {
  const { section, workspaceName } = props;
  const overrides = usePref(COLLAPSED_PREF);
  // This visit's choice, held here too: a storage that refuses the write must
  // not leave the header unable to open or close its section.
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const collapsed = chosen ?? overrides[section.id] ?? DEFAULT_COLLAPSED[section.id];
  const toggle = () => {
    setChosen(!collapsed);
    const next = { ...overrides, [section.id]: !collapsed };
    // Back to the default is no override at all.
    if (next[section.id] === DEFAULT_COLLAPSED[section.id]) delete next[section.id];
    writePref(COLLAPSED_PREF, next);
  };
  const { title, explain } = sectionCopy(section.id, workspaceName);
  const bodyId = `installed-section-${section.id}`;

  return (
    <section data-testid={`installed-section-${section.id}`} data-collapsed={collapsed}>
      <h2 className="border-b border-border">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggle}
          className="flex w-full items-baseline gap-2 rounded-sm py-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 self-center text-muted-foreground transition-transform motion-reduce:transition-none",
              !collapsed && "rotate-90",
            )}
            aria-hidden
          />
          <span
            className={cn(
              "text-sm font-semibold",
              section.id === "not-here" && "text-muted-foreground",
            )}
          >
            {title}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="installed-section-count">
            {countLine(section.plugins.length, section.skills.length)}
          </span>
        </button>
      </h2>
      {!collapsed && (
        <div id={bodyId}>
          <p className="mt-1.5 mb-1 pl-5.5 text-xs text-muted-foreground">{explain}</p>
          {section.plugins.length > 0 && (
            <SubList kind="plugins" items={section.plugins} sectionId={section.id}>
              {(plugin) => <PluginRow key={plugin.id} {...props} plugin={plugin} />}
            </SubList>
          )}
          {section.skills.length > 0 && (
            <SubList kind="skills" items={section.skills} sectionId={section.id}>
              {(skill) => <SkillRow key={skill.id} {...props} skill={skill} />}
            </SubList>
          )}
        </div>
      )}
    </section>
  );
}

/** One kind's rows in a section: the first few, then all of them on request. */
function SubList<T>({
  kind,
  items,
  sectionId,
  children,
}: {
  kind: "plugins" | "skills";
  items: T[];
  sectionId: SectionId;
  children: (item: T) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SUBLIST_PREVIEW);
  const hidden = items.length - SUBLIST_PREVIEW;
  const label = kind === "plugins" ? "Plugins" : "Skills";
  return (
    <div data-testid={`installed-${sectionId}-${kind}`}>
      <h3 className="mt-3 mb-0.5 pl-5.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label} · {items.length}
      </h3>
      <div>{shown.map(children)}</div>
      {hidden > 0 && (
        <ShowAllButton
          all={all}
          total={items.length}
          noun={kind}
          onToggle={() => setAll(!all)}
          className="ml-5.5"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROW_LINK =
  "outline-none after:absolute after:inset-y-0 after:-inset-x-1 after:rounded-sm after:transition-colors hover:after:bg-foreground/5 focus-visible:after:ring-2 focus-visible:after:ring-ring";

/**
 * One plugin: its icon, name and account on one line, what it asks of the
 * viewer, and its ⋯ menu. The whole row opens the plugin's page: the name's
 * link stretches over the row, and the action and the menu sit above it,
 * beside the link rather than inside it, because a control cannot nest inside
 * a link.
 */
function PluginRow({
  plugin,
  pluginTo,
  rowAction,
  rowMenu,
  justConnected,
  ownerMark,
  meta,
  inset = true,
}: InstalledViewProps & {
  plugin: Plugin;
  /** Whose it is, marked on the icon when the row is shown outside its section. */
  ownerMark?: ItemOwner;
  /** The line beside the name; the account by default. */
  meta?: string;
  inset?: boolean;
}) {
  const fresh = justConnected(plugin);
  const rowRef = useRef<HTMLDivElement>(null);
  // A long list may hold the plugin below the fold.
  useEffect(() => {
    if (fresh) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [fresh]);
  const action = rowAction(plugin);
  const muted = plugin.owner.kind === "person" && !plugin.granted;
  const line = meta ?? accountLine(plugin);

  return (
    <div
      ref={rowRef}
      className={cn(
        "relative flex min-h-11 items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0",
        inset && "pl-5.5",
      )}
      data-testid="plugin-row"
      data-plugin-id={plugin.id}
    >
      <span className="relative shrink-0">
        <ConnectorIcon
          name={plugin.displayName}
          iconUrl={plugin.iconUrl}
          className={cn("h-6 w-6 rounded text-[11px]", muted && "opacity-60")}
        />
        {ownerMark && <OwnerMark owner={ownerMark} />}
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <Link
          to={pluginTo(plugin)}
          data-row-link
          className={cn("shrink-0 text-sm font-medium", ROW_LINK)}
        >
          {plugin.displayName}
        </Link>
        {line && (
          <span className="truncate text-xs text-muted-foreground" data-testid="plugin-account">
            {line}
          </span>
        )}
      </div>
      {fresh && (
        <span className="relative flex shrink-0 items-center gap-1.5 text-xs font-medium text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span>Connected just now</span>
        </span>
      )}
      {action && (
        <div className="relative shrink-0" data-testid="plugin-action">
          {action}
        </div>
      )}
      <RowMenu name={plugin.displayName} items={rowMenu(plugin)} testId="plugin-menu" />
    </div>
  );
}

/**
 * One skill, as text: its name, when it loads, and its ⋯ menu. An org skill is
 * tagged, since it sits beside the workspace's under Shared. A skill that is
 * off reads muted.
 */
function SkillRow({
  skill,
  skillTo,
  skillControl,
  ownerMark,
  inset = true,
}: InstalledViewProps & { skill: AuthoredSkill; ownerMark?: ItemOwner; inset?: boolean }) {
  const mechanism = skillMechanismLabel(skill);
  const off = skill.status !== "active";
  const to = skillTo(skill);
  const control = skillControl?.(skill);
  return (
    <div
      className={cn(
        "relative flex min-h-10 items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0",
        inset && "pl-5.5",
      )}
      data-testid="skill-row"
      data-skill-scope={skill.scope}
      data-skill-name={skill.name}
    >
      {ownerMark && (
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
          <OwnerMark owner={ownerMark} standalone />
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <Link to={to} className={cn("shrink-0 text-sm", off && "text-muted-foreground", ROW_LINK)}>
          {skill.name}
        </Link>
        {skill.scope === "org" && (
          <Badge variant="outline" className="relative" data-testid="skill-org-tag">
            Org
          </Badge>
        )}
        {mechanism && (
          <span className="truncate text-xs text-muted-foreground" data-testid="skill-facts">
            {mechanism.text}
            {mechanism.mono && <span className="font-mono"> {mechanism.mono}</span>}
          </span>
        )}
      </div>
      {off && <span className="relative shrink-0 text-xs text-muted-foreground">Off</span>}
      {control && <div className="relative shrink-0">{control}</div>}
      <RowMenu
        name={skill.name}
        items={[{ kind: "link", label: "Open", to }]}
        testId="skill-menu"
      />
    </div>
  );
}

/**
 * Whose a row is, as a small mark: on the corner of a plugin's icon, or on its
 * own where a skill has no icon.
 */
function OwnerMark({ owner, standalone = false }: { owner: ItemOwner; standalone?: boolean }) {
  const Icon = owner === "you" ? User : Users;
  const label = owner === "you" ? "Just you" : "Shared";
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="owner-mark"
      data-owner={owner}
      className={cn(
        "flex items-center justify-center rounded-full text-background ring-2 ring-background",
        owner === "you" ? "bg-(--scope-user)" : "bg-(--scope-workspace)",
        standalone ? "h-4 w-4" : "absolute -right-1 -bottom-1 h-3.5 w-3.5",
      )}
    >
      <Icon className={standalone ? "h-2.5 w-2.5" : "h-2 w-2"} aria-hidden strokeWidth={3} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Row menu
// ---------------------------------------------------------------------------

/** An item in a row's ⋯ menu: a link, or an action. */
export type RowMenuItem =
  | { kind: "link"; label: string; to: string }
  | { kind: "action"; label: string; onSelect: () => void; destructive?: boolean };

function RowMenu({
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
          className="relative shrink-0 rounded-sm p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground data-[popup-open]:bg-foreground/10"
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
