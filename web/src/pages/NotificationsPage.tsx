import { AlertTriangle, Bell, ChevronRight, Info, Search, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  type DeliveryOutcome,
  type DeliveryRecord,
  listNotifications,
  type NotificationLevel,
  type NotificationsListInput,
  type NotificationView,
} from "../api/notifications";
import { ConnectorIcon } from "../components/connectors/ConnectorIcon";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { useNotifications } from "../context/NotificationsContext";
import { useShellContext } from "../context/ShellContext";
import { useWorkspaceAppIcons } from "../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { formatInstant, formatInstantFull } from "../lib/format";
import { INBOX_PAGE_SIZE, LEVEL_RANK } from "../lib/notification-levels";
import { resolveNotificationLink } from "../lib/notification-link";
import { cn } from "../lib/utils";
import { EmptyState, InlineError } from "./settings/components";

/**
 * The inbox — what this workspace's connectors recorded without being asked.
 *
 * One scrolling column, each item expanding in place, because this renders in
 * the main-area slot beside the docked chat and that column is narrow (see
 * `web/DESIGN.md`). No master/detail.
 *
 * **Everything a connector wrote is text.** `title`, `subject` and `body` are
 * plain strings from a third-party server, rendered as plain strings: no
 * markdown, no HTML, and no clickable affordance built out of a URI the host
 * cannot resolve. That is not styling restraint, it is the boundary — an inbox
 * that rendered connector markup would be a third-party server drawing in the
 * operator's own chrome.
 *
 * `data` is the connector's structured payload. The runtime forwards it unread,
 * and this page shows it only behind a labelled disclosure, as raw JSON, so
 * nobody mistakes it for something the platform interpreted.
 *
 * **Filters run on the server.** The page holds one capped page of the inbox,
 * so a filter applied to it in the browser would quietly miss everything older
 * than the page. The filters live in the URL, so a filtered view is a link and
 * Back returns to it.
 */

const LEVEL_META: Record<
  NotificationLevel,
  { label: string; icon: typeof Info; className: string; edge: string }
> = {
  info: {
    label: "Info",
    icon: Info,
    className: "text-muted-foreground",
    // Transparent, not absent: every row carries the same edge width, so an
    // info row's text lines up with the coloured rows around it.
    edge: "border-l-2 border-l-transparent",
  },
  attention: {
    label: "Attention",
    icon: AlertTriangle,
    className: "text-warning",
    edge: "border-l-2 border-l-warning",
  },
  urgent: {
    label: "Urgent",
    icon: Zap,
    className: "text-destructive",
    edge: "border-l-2 border-l-destructive",
  },
};

/** The time filter's windows, by their URL value. */
const WITHIN: Record<string, { label: string; ms: number }> = {
  "24h": { label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
};

/** The filters, as the URL holds them. Absent means "any". */
interface InboxFilters {
  unreadOnly: boolean;
  level?: NotificationLevel;
  app?: string;
  within?: string;
  q?: string;
}

function readFilters(params: URLSearchParams): InboxFilters {
  const level = params.get("level");
  const within = params.get("within");
  return {
    unreadOnly: params.get("status") === "unread",
    level: level === "attention" || level === "urgent" ? level : undefined,
    app: params.get("app") || undefined,
    within: within && within in WITHIN ? within : undefined,
    q: params.get("q")?.trim() || undefined,
  };
}

function hasFilters(f: InboxFilters): boolean {
  return f.unreadOnly || !!f.level || !!f.app || !!f.within || !!f.q;
}

/** The filters as `notifications__list` arguments, leaving out what is "any". */
function listArgsFrom(filters: InboxFilters): NotificationsListInput {
  const args: NotificationsListInput = { limit: INBOX_PAGE_SIZE };
  if (filters.unreadOnly) args.unreadOnly = true;
  if (filters.level) args.level = filters.level;
  if (filters.app) args.source = filters.app;
  if (filters.within) args.since = new Date(Date.now() - WITHIN[filters.within].ms).toISOString();
  if (filters.q) args.query = filters.q;
  return args;
}

/**
 * The page's own read of the inbox, filtered. Re-read when the filters change
 * and when the shell's inbox `revision` moves, which is how a live item lands
 * here without the page opening a stream of its own.
 *
 * Addressed to `workspaceId` explicitly, and a response that lands after a
 * newer read was issued is dropped.
 *
 * **A row read here stays here until the view changes.** Marking a row read
 * moves `revision`, and under a filter that excludes read items (Unread) the
 * re-read no longer returns it — so the row someone just opened would vanish
 * under them. Rows marked through `markLocally` are held across re-reads of
 * the same filters and workspace, and let go when either changes.
 */
function useInboxList(workspaceId: string | undefined, filters: InboxFilters, revision: number) {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const kept = useRef(new Set<string>());
  const scope = useRef<{ workspaceId?: string; key?: string }>({});
  const key = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `filters`, and `revision` is the re-read signal
  useEffect(() => {
    if (!workspaceId) return;
    if (scope.current.workspaceId !== workspaceId || scope.current.key !== key) {
      kept.current.clear();
      // Another workspace's rows must not sit under this one's name while
      // its read is in flight. A filter change keeps the rows until it lands.
      if (scope.current.workspaceId !== workspaceId) setItems([]);
      scope.current = { workspaceId, key };
    }
    const mine = ++seq.current;
    listNotifications(listArgsFrom(filters), workspaceId)
      .then((out) => {
        if (mine !== seq.current) return;
        setItems((current) => {
          const returned = new Set(out.notifications.map((item) => item.id));
          const held = current.filter(
            (item) => kept.current.has(item.id) && !returned.has(item.id),
          );
          return [...out.notifications, ...held];
        });
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : "Could not read this workspace's inbox");
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [workspaceId, key, revision]);

  /** Paint these rows read, and hold them through re-reads of this view. */
  const markLocally = useCallback((ids: string[]) => {
    const readAt = new Date().toISOString();
    for (const id of ids) kept.current.add(id);
    setItems((current) =>
      current.map((item) => (ids.includes(item.id) && !item.readAt ? { ...item, readAt } : item)),
    );
  }, []);

  return { items, markLocally, loading, error };
}

export function NotificationsPage() {
  const { slug } = useParams<{ slug: string }>();
  const shell = useShellContext();
  const { activeWorkspace } = useWorkspaceContext();
  const { unread, revision, markRead } = useNotifications();
  // `?item=` is how a delivered notification links back here from outside the
  // shell — the `{{inbox.url}}` a route template rendered into Slack or mail.
  // The reader followed a link to one item, so it opens expanded and scrolled
  // to rather than leaving them to find it in a list of a hundred.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("item");
  const [open, setOpen] = useState<Set<string>>(() => new Set(focusId ? [focusId] : []));
  const filters = readFilters(searchParams);
  const filtered = hasFilters(filters);
  const { items, markLocally, loading, error } = useInboxList(
    activeWorkspace?.id,
    filters,
    revision,
  );

  const placements = useMemo(
    () => (shell ? [...shell.forSlot("sidebar"), ...shell.forSlot("main")] : []),
    [shell],
  );

  // Urgency first, then newest. An inbox read top-down should not make somebody
  // scroll past a week of routine items to find the one thing on fire; within a
  // level the order is the arrival order the store assigned.
  const ordered = useMemo(
    () => [...items].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.seq - a.seq),
    [items],
  );

  const setFilter = useCallback(
    (name: string, value: string | undefined) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set(name, value);
          else next.delete(name);
          next.delete("item");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const clearFilters = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams]);

  // Marked here and in the shell's count at once: this list paints the rows
  // read, and the shell drops the bell. The shell's re-read after the call
  // moves `revision`, which re-reads this list from the store.
  const markIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      markLocally(ids);
      void markRead(ids).catch(() => {});
    },
    [markRead, markLocally],
  );

  const toggle = useCallback(
    (item: NotificationView) => {
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      // Opening an item is reading it. Closing one is not un-reading it.
      if (!open.has(item.id) && !item.readAt) markIds([item.id]);
    },
    [open, markIds],
  );

  // Following a link to an item is reading it, on the same rule `toggle` uses.
  // Guarded on the item existing: a link to something pruned, or to another
  // workspace's item, marks nothing and simply lands on the list.
  const focusPresent = focusId !== null && items.some((i) => i.id === focusId);
  const marked = useRef(false);
  useEffect(() => {
    if (!focusPresent || marked.current) return;
    marked.current = true;
    const item = items.find((i) => i.id === focusId);
    if (item && !item.readAt) markIds([item.id]);
  }, [focusPresent, focusId, items, markIds]);

  const sources = useMemo(() => [...new Set(items.map((item) => item.source))], [items]);
  const shownUnread = ordered.filter((item) => !item.readAt).map((item) => item.id);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <InboxFilterBar filters={filters} onChange={setFilter} sources={sources} />

        <div className="flex min-h-8 items-center justify-between gap-4 text-sm">
          <span data-testid="inbox-unread-count" className="text-muted-foreground">
            {unread > 0 ? `${unread} unread` : "All read"}
          </span>
          {shownUnread.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => markIds(shownUnread)}>
              {/* "All" only when the rows on screen are all of it. */}
              {filtered || unread > shownUnread.length ? "Mark shown read" : "Mark all read"}
            </Button>
          )}
        </div>

        {error ? <InlineError message={error} /> : null}

        {loading && ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}

        {!loading && ordered.length === 0 && !error && filtered ? (
          <EmptyState
            message={
              <>
                Nothing matches these filters.{" "}
                <button type="button" className="underline" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            }
          />
        ) : null}

        {!loading && ordered.length === 0 && !error && !filtered ? (
          <EmptyState
            message={
              <>
                Nothing yet. This fills when a connector that declares an outbox has something to
                report — the runtime polls it and files what it finds here.{" "}
                {slug ? (
                  <Link className="underline" to={`/w/${slug}/settings/notifications`}>
                    Notification settings
                  </Link>
                ) : (
                  "Notification settings"
                )}{" "}
                lists the connectors in this workspace that do.
              </>
            }
          />
        ) : null}

        <ul className="divide-y divide-border/60 overflow-hidden rounded-sm border border-border/60 bg-card empty:hidden">
          {ordered.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              expanded={open.has(item.id)}
              focused={item.id === focusId}
              onToggle={() => toggle(item)}
              href={
                item.link ? resolveNotificationLink(item.link.resource, placements, slug) : null
              }
            />
          ))}
        </ul>

        {ordered.length >= INBOX_PAGE_SIZE ? (
          <p className="text-xs text-muted-foreground">
            Showing the most recent {ordered.length}. Older items stay in the inbox for 90 days and
            are reachable by narrowing the filters or asking the agent for them.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Status, level, app, time, and text. Each control writes its own URL param;
 * the text box waits for a pause in typing so each keystroke is not a read.
 */
function InboxFilterBar({
  filters,
  onChange,
  sources,
}: {
  filters: InboxFilters;
  onChange: (name: string, value: string | undefined) => void;
  /** The sources of the items on screen, which need not all be installed. */
  sources: string[];
}) {
  const { connectors } = useWorkspaceAppIcons();
  const apps = useMemo(() => {
    const installed = connectors?.installed ?? [];
    const label = (source: string) =>
      installed.find((c) => c.serverName === source)?.displayName ?? source;
    // Installed apps, plus any source already in the inbox: an item can outlive
    // its connector's install, and a link naming that source still selects it.
    const values = new Set([
      ...installed.map((c) => c.serverName),
      ...sources,
      ...(filters.app ? [filters.app] : []),
    ]);
    return [...values]
      .map((value) => ({ value, label: label(value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [connectors, sources, filters.app]);

  const [text, setText] = useState(filters.q ?? "");
  useEffect(() => setText(filters.q ?? ""), [filters.q]);
  useEffect(() => {
    const value = text.trim() || undefined;
    if (value === filters.q) return;
    const id = setTimeout(() => onChange("q", value), 250);
    return () => clearTimeout(id);
  }, [text, filters.q, onChange]);

  const selectClass = "h-8 w-auto";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="inbox-filters">
      <fieldset className="flex gap-0.5 rounded-sm border border-input bg-secondary p-0.5">
        <legend className="sr-only">Status</legend>
        {[
          { value: undefined, label: "All" },
          { value: "unread", label: "Unread" },
        ].map((option) => {
          const active = (option.value === "unread") === filters.unreadOnly;
          return (
            <button
              key={option.label}
              type="button"
              aria-pressed={active}
              onClick={() => onChange("status", option.value)}
              className={cn(
                "rounded-xs px-2.5 py-0.5 text-sm transition-colors",
                active
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>
      <Select
        aria-label="Level"
        className={selectClass}
        value={filters.level ?? ""}
        onChange={(e) => onChange("level", e.target.value || undefined)}
      >
        <option value="">Any level</option>
        <option value="attention">Attention and up</option>
        <option value="urgent">Urgent</option>
      </Select>
      <Select
        aria-label="App"
        className={selectClass}
        value={filters.app ?? ""}
        onChange={(e) => onChange("app", e.target.value || undefined)}
      >
        <option value="">Any app</option>
        {apps.map((app) => (
          <option key={app.value} value={app.value}>
            {app.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Time"
        className={selectClass}
        value={filters.within ?? ""}
        onChange={(e) => onChange("within", e.target.value || undefined)}
      >
        <option value="">Any time</option>
        {Object.entries(WITHIN).map(([value, { label }]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <div className="relative min-w-40 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search title or event"
          placeholder="Search title or event"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-8 pl-8"
        />
      </div>
    </div>
  );
}

/**
 * A ref that scrolls its element into view when `active` becomes true.
 *
 * Extracted from the row rather than inlined: exactly one row in the list is
 * ever `active` (the one `?item=` names), so this is a single call on a single
 * mount rather than a scroll war, and saying that once here is cheaper than
 * re-reading it out of the row's render.
 */
function useScrollIntoViewWhen<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);
  return ref;
}

/**
 * The rows share one bordered list and are split by its dividers, so a row
 * draws a border only to mark "this is the one you followed a link to". Inset,
 * so the ring sits inside the list's border instead of over a neighbour's.
 */
function rowChrome(focused: boolean): string {
  return cn(focused && "ring-1 ring-inset ring-primary");
}

function NotificationRow({
  item,
  expanded,
  focused,
  onToggle,
  href,
}: {
  item: NotificationView;
  expanded: boolean;
  /** Named by `?item=` — the row a link from outside the shell points at. */
  focused: boolean;
  onToggle: () => void;
  href: string | null;
}) {
  const level = LEVEL_META[item.level];
  const ref = useScrollIntoViewWhen<HTMLLIElement>(focused);
  const { connectors } = useWorkspaceAppIcons();
  const app = connectors?.installed.find((c) => c.serverName === item.source);
  const appName = app?.displayName ?? item.source;

  return (
    <li ref={ref} className={cn(rowChrome(focused), level.edge)}>
      <NotificationRowHead
        item={item}
        expanded={expanded}
        onToggle={onToggle}
        appName={appName}
        appIconUrl={app?.iconUrl}
      />

      {expanded ? (
        <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border/60">
          {item.body ? (
            // `whitespace-pre-wrap` on a plain string. The server's newlines
            // survive; nothing else it wrote is interpreted.
            <p className="text-sm whitespace-pre-wrap break-words pt-3">{item.body}</p>
          ) : null}

          {item.link ? <NotificationLink uri={item.link.resource} href={href} /> : null}

          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <dt>Event</dt>
            <dd className="font-mono text-foreground/80">{item.name}</dd>
            <dt>Received</dt>
            <dd>{formatInstantFull(item.receivedAt)}</dd>
            {/* Only when a ceiling actually held the item down. Shown here and
                not on the row because it explains the ledger below it: a route
                asking for a level above this one did not fire, and this is the
                only place that says why. */}
            {item.effectiveLevel ? (
              <>
                <dt>Routed at</dt>
                <dd data-testid="effective-level">
                  {item.effectiveLevel} — this workspace holds {item.source} to that ceiling
                </dd>
              </>
            ) : null}
          </dl>

          {item.deliveries && item.deliveries.length > 0 ? (
            <DeliveryLedger rows={item.deliveries} />
          ) : null}

          <RawDetails data={item.data} />
        </div>
      ) : null}
    </li>
  );
}

/** The row's always-visible line: unread dot, level, title, app, time, subject. */
function NotificationRowHead({
  item,
  expanded,
  onToggle,
  appName,
  appIconUrl,
}: {
  item: NotificationView;
  expanded: boolean;
  onToggle: () => void;
  appName: string;
  appIconUrl?: string;
}) {
  const level = LEVEL_META[item.level];
  const LevelIcon = level.icon;
  const unread = !item.readAt;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="notification-row"
      data-level={item.level}
      data-unread={unread ? "true" : "false"}
      className="w-full flex items-start gap-2.5 px-3 py-3 text-left hover:bg-foreground/5 transition-colors"
    >
      {/* The bell's dot, on the row it stands for. Read rows keep the
            slot so titles stay aligned. */}
      <span
        aria-hidden="true"
        data-testid={unread ? "notification-unread-dot" : undefined}
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", unread && "bg-primary")}
      />
      <LevelIcon aria-hidden="true" className={cn("size-4 shrink-0 mt-0.5", level.className)} />
      <span className="min-w-0 flex-1">
        <span
          data-testid="notification-title"
          className={cn(
            "block text-sm truncate",
            unread ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ConnectorIcon
              name={appName}
              iconUrl={appIconUrl}
              className="size-3.5 rounded-xs text-3xs"
            />
            {appName}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={item.timestamp} title={formatInstantFull(item.timestamp)}>
            {formatInstant(item.timestamp)}
          </time>
          {item.subject ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{item.subject}</span>
            </>
          ) : null}
          <span className="sr-only">{`${level.label}${unread ? ", unread" : ""}`}</span>
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn("size-4 shrink-0 mt-0.5 transition-transform", expanded && "rotate-90")}
      />
    </button>
  );
}

/**
 * The link, as a link only where the shell can open it.
 *
 * See `resolveNotificationLink` for the rule. A URI the shell cannot resolve is
 * still shown — an operator can read it, and it is often the only way to tell
 * which record upstream the item is about — but it is text, and a URI that
 * looks like a link and does nothing is worse than one that never claimed to be.
 */
function NotificationLink({ uri, href }: { uri: string; href: string | null }) {
  if (href) {
    return (
      <Link to={href} className="inline-flex items-center gap-1.5 text-sm text-primary underline">
        <Bell aria-hidden="true" className="size-3.5" />
        Open
      </Link>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Linked resource: <code className="font-mono break-all">{uri}</code>
    </p>
  );
}

/**
 * How each ledger outcome reads, and what it is coloured.
 *
 * `pending` and `deferred` are neither good nor bad — one is a tool call
 * mid-flight and the other is an automation's debounce window still open — so
 * neither takes a colour. Everything the runtime gave up on is destructive,
 * whatever the reason: an operator scanning for "did this get through" wants
 * one signal and the classification beside it for the detail.
 */
const OUTCOME_LABEL: Record<DeliveryOutcome, string> = {
  pending: "sending",
  delivered: "delivered",
  deferred: "batching for the automation",
  denied: "refused",
  skipped: "skipped",
  failed: "failed",
};

const OUTCOME_CLASS: Record<DeliveryOutcome, string> = {
  pending: "",
  delivered: "text-success",
  deferred: "",
  denied: "text-destructive",
  skipped: "text-destructive",
  failed: "text-destructive",
};

/** One row per route target that matched. */
function DeliveryLedger({ rows }: { rows: DeliveryRecord[] }) {
  return (
    <div className="space-y-1.5" data-testid="delivery-ledger">
      <p className="text-xs font-semibold">Delivery</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={`${row.routeId}:${row.index}:${row.target}`}
            className="text-xs text-muted-foreground"
          >
            <span className="font-mono text-foreground/80">{row.target}</span>{" "}
            <span className={cn(OUTCOME_CLASS[row.outcome])}>{OUTCOME_LABEL[row.outcome]}</span>
            {row.attempts > 1 ? ` after ${row.attempts} attempts` : null}
            {row.lastError ? <span className="block break-words">{row.lastError}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The connector's own payload, collapsed and labelled as raw.
 *
 * The runtime never reads a field of it, so neither does this page: it is
 * printed as JSON. Labelling it is the point — an operator opening this should
 * know they are looking at what a third-party server sent, not at anything the
 * platform verified or acted on.
 */
function RawDetails({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? "Hide" : "Show"} details — raw data from the connector
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-sm bg-muted/50 p-2 text-2xs font-mono whitespace-pre-wrap break-words">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
