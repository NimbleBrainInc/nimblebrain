import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type NotificationDeliverTarget,
  type NotificationLevel,
  type NotificationRouteInput,
  type NotificationRouteMatch,
  type NotificationRouteView,
  type NotificationSourceView,
  type NotificationsSettingsOutput,
  readNotificationSettings,
  setNotificationRoutes,
  setNotificationSourceLevel,
} from "../../api/notifications";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { NOTIFICATION_LEVELS } from "../../lib/notification-levels";
import {
  EmptyState,
  InlineError,
  RequireActiveWorkspace,
  Section,
  SettingsPageHeader,
} from "./components";

/**
 * Notifications — the ceilings and the routes.
 *
 * Two operator decisions live here, and they are the whole of the operator's
 * half of the design. A connector that declares an outbox gains nothing by
 * declaring it: items land in the inbox, and nothing leaves this workspace
 * until an admin raises that source's ceiling and writes a route. Both writes
 * are workspace-admin only, gated in two places that answer different
 * questions — the nav entry's `minRole` decides whether the tab is worth
 * showing, the tool decides whether the write lands. A hidden tab is not a
 * permission.
 *
 * The pickers are populated from the same read the server validates against,
 * so the editor cannot offer a target the write would refuse.
 */

/**
 * Editor identity for a row that has none of its own.
 *
 * A route gets its `id` from the server on first save, and a target never gets
 * one — it is a position in a list. React still needs a key that survives a
 * reorder, and an index does not: delete the first of three targets and every
 * later row inherits the previous row's DOM node, its focus, and its
 * half-typed JSON. A counter minted at construction follows the row instead.
 */
let nextKey = 0;
function newKey(): string {
  nextKey += 1;
  return `k${nextKey}`;
}

/** One delivery target, with the `input` JSON exactly as it is being typed. */
interface TargetDraft {
  key: string;
  target: NotificationDeliverTarget;
  /** Parsed on save, so a half-typed object survives every re-render until then. */
  inputText: string;
}

/** A route in the editor: the writable shape, plus who currently owns it. */
interface RouteDraft {
  key: string;
  /** Absent for a route that has never been saved. */
  id?: string;
  /** Absent for a route that has never been saved. */
  createdBy?: string;
  match: NotificationRouteMatch;
  targets: TargetDraft[];
}

const ANY = "";

function toDraft(route: NotificationRouteView): RouteDraft {
  return {
    key: newKey(),
    id: route.id,
    createdBy: route.createdBy,
    match: route.match,
    targets: route.deliver.map((target) => ({
      key: newKey(),
      target: { ...target },
      inputText:
        target.kind === "tool" && target.input ? JSON.stringify(target.input, null, 2) : "",
    })),
  };
}

function emptyTarget(): TargetDraft {
  return { key: newKey(), target: { kind: "tool", tool: "" }, inputText: "" };
}

function emptyDraft(): RouteDraft {
  return { key: newKey(), match: {}, targets: [emptyTarget()] };
}

export function WorkspaceNotificationsTab() {
  const [settings, setSettings] = useState<NotificationsSettingsOutput | null>(null);
  const [routes, setRoutes] = useState<RouteDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((next: NotificationsSettingsOutput) => {
    setSettings(next);
    setRoutes(next.routes.map(toDraft));
    setError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await readNotificationSettings());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not read this workspace's notification settings",
      );
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeLevel = async (source: string, maxLevel: NotificationLevel) => {
    setSaved(false);
    try {
      apply(await setNotificationSourceLevel({ source, maxLevel }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the ceiling");
    }
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const payload = routes.map(materialize);
      apply(await setNotificationRoutes({ routes: payload }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the routes");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Notifications"
        description="What this workspace's connectors may report, and where it goes. A connector records facts on its own; nothing leaves this workspace until you raise its ceiling and write a route."
      />
      <RequireActiveWorkspace>
        {error ? <InlineError message={error} /> : null}

        {settings && !settings.routesExecuted ? (
          <p
            data-testid="routes-not-executed"
            className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          >
            Routes are saved but not yet executed in this version. What you write here is stored,
            validated and shown; nothing dispatches it. The inbox and the ceilings below work now.
          </p>
        ) : null}

        <Section
          flush
          title="Sources"
          description="Every connector in this workspace that declares an outbox. The ceiling is the highest level its notifications may reach a route at — a new source starts at info, so a route asking for attention or urgency never fires for it until you raise this."
        >
          {settings ? <SourceList sources={settings.sources} onChange={changeLevel} /> : null}
        </Section>

        <Section
          title="Routes"
          description="A route matches notifications and delivers them. Match on source, on the event name the connector chose, and on a minimum level; deliver to a tool this workspace has installed, or wake one of your automations."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRoutes((current) => [...current, emptyDraft()])}
            >
              <Plus className="size-3.5 mr-1.5" />
              Add route
            </Button>
          }
        >
          <div className="space-y-4">
            {routes.length === 0 ? (
              <EmptyState message="No routes. Notifications still arrive in the inbox — a route is what sends one somewhere else." />
            ) : null}
            {routes.map((route, i) => (
              <RouteEditor
                key={route.key}
                route={route}
                settings={settings}
                onChange={(next) =>
                  setRoutes((current) => current.map((r, j) => (j === i ? next : r)))
                }
                onRemove={() => setRoutes((current) => current.filter((_, j) => j !== i))}
              />
            ))}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()} disabled={saving || settings === null}>
                {saving ? "Saving…" : "Save routes"}
              </Button>
              {saved ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
              <span className="text-xs text-muted-foreground">
                Saving replaces this workspace's whole route list, and stamps you as the author of
                every route in it — the identity each one would dispatch under.
              </span>
            </div>
          </div>
        </Section>
      </RequireActiveWorkspace>
    </div>
  );
}

function SourceList({
  sources,
  onChange,
}: {
  sources: NotificationSourceView[];
  onChange: (source: string, level: NotificationLevel) => void;
}) {
  if (sources.length === 0) {
    return (
      <EmptyState message="No connector in this workspace declares an outbox, so there is nothing to hold a ceiling for. A connector that reports asynchronous facts declares one in its manifest." />
    );
  }
  return (
    <ul className="space-y-3">
      {sources.map((source) => (
        <li
          key={source.source}
          data-testid="notification-source"
          data-source={source.source}
          className="flex flex-wrap items-start justify-between gap-3 rounded-sm border border-border/60 p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{source.label}</p>
            <p className="text-xs font-mono text-muted-foreground">{source.source}</p>
            {source.description ? (
              <p className="mt-1 text-sm text-muted-foreground">{source.description}</p>
            ) : null}
          </div>
          <div className="w-40 shrink-0 space-y-1">
            <Label className="text-xs text-muted-foreground">Ceiling</Label>
            <Select
              aria-label={`Level ceiling for ${source.label}`}
              value={source.maxLevel}
              onChange={(e) => onChange(source.source, e.target.value as NotificationLevel)}
            >
              {NOTIFICATION_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
            {!source.configured ? <p className="text-2xs text-muted-foreground">Default</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function RouteEditor({
  route,
  settings,
  onChange,
  onRemove,
}: {
  route: RouteDraft;
  settings: NotificationsSettingsOutput | null;
  onChange: (next: RouteDraft) => void;
  onRemove: () => void;
}) {
  const setMatch = (patch: Partial<NotificationRouteMatch>) =>
    onChange({ ...route, match: prune({ ...route.match, ...patch }) });

  const setTarget = (key: string, patch: Partial<Omit<TargetDraft, "key">>) =>
    onChange({
      ...route,
      targets: route.targets.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    });

  return (
    <div className="rounded-sm border border-border/60 p-3 space-y-3" data-testid="route-editor">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{route.id ?? "New route"}</p>
          {route.createdBy ? (
            <p className="text-xs text-muted-foreground">
              Dispatches as <span className="font-mono">{route.createdBy}</span>
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove route">
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Source</Label>
          <Select
            aria-label="Match source"
            value={route.match.source ?? ANY}
            onChange={(e) => setMatch({ source: e.target.value || undefined })}
          >
            <option value={ANY}>Any source</option>
            {(settings?.sources ?? []).map((s) => (
              <option key={s.source} value={s.source}>
                {s.source}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Event name</Label>
          <Input
            aria-label="Match event name"
            placeholder="domain.* — any name if blank"
            value={route.match.name ?? ""}
            onChange={(e) => setMatch({ name: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Minimum level</Label>
          <Select
            aria-label="Match minimum level"
            value={route.match.level ?? ANY}
            onChange={(e) =>
              setMatch({ level: (e.target.value || undefined) as NotificationLevel | undefined })
            }
          >
            <option value={ANY}>Any level</option>
            {NOTIFICATION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level} and above
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        {route.targets.map((draft) => (
          <TargetEditor
            key={draft.key}
            target={draft.target}
            inputText={draft.inputText}
            settings={settings}
            onChange={(target, inputText) =>
              setTarget(draft.key, inputText === undefined ? { target } : { target, inputText })
            }
            onRemove={
              route.targets.length > 1
                ? () =>
                    onChange({
                      ...route,
                      targets: route.targets.filter((t) => t.key !== draft.key),
                    })
                : undefined
            }
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...route, targets: [...route.targets, emptyTarget()] })}
        >
          <Plus className="size-3.5 mr-1.5" />
          Add target
        </Button>
      </div>
    </div>
  );
}

function TargetEditor({
  target,
  inputText,
  settings,
  onChange,
  onRemove,
}: {
  target: NotificationDeliverTarget;
  inputText: string;
  settings: NotificationsSettingsOutput | null;
  onChange: (next: NotificationDeliverTarget, text?: string) => void;
  onRemove?: () => void;
}) {
  const placeholders = (settings?.placeholders ?? []).map((p) => `{{${p}}}`).join(", ");
  // A route can outlive the thing it names — the connector was uninstalled, the
  // automation deleted. Dropping the stored value from the picker would silently
  // rewrite the route to "nothing" the next time anyone pressed Save, so the
  // gone target stays selectable and says what it is. Saving it is refused,
  // which is the reader's cue to change or remove it.
  const toolOptions = withCurrent(
    settings?.deliverableTools ?? [],
    target.kind === "tool" ? target.tool : "",
  );
  const automationOptions = withCurrentAutomation(
    settings?.automations ?? [],
    target.kind === "agent" ? target.automation : "",
  );
  return (
    <div className="rounded-sm bg-muted/40 p-3 space-y-2" data-testid="route-target">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32 space-y-1">
          <Label className="text-xs text-muted-foreground">Deliver to</Label>
          <Select
            aria-label="Target kind"
            value={target.kind}
            onChange={(e) =>
              onChange(
                e.target.value === "agent"
                  ? { kind: "agent", automation: "" }
                  : { kind: "tool", tool: "" },
                "",
              )
            }
          >
            <option value="tool">A tool</option>
            <option value="agent">An automation</option>
          </Select>
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          {target.kind === "tool" ? (
            <>
              <Label className="text-xs text-muted-foreground">Tool</Label>
              <Select
                aria-label="Target tool"
                value={target.tool}
                onChange={(e) => onChange({ ...target, tool: e.target.value })}
              >
                <option value="">Choose a tool…</option>
                {toolOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            <>
              <Label className="text-xs text-muted-foreground">Automation</Label>
              <Select
                aria-label="Target automation"
                value={target.automation}
                onChange={(e) => onChange({ ...target, automation: e.target.value })}
              >
                <option value="">Choose an automation…</option>
                {automationOptions.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>
        {onRemove ? (
          <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove target">
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {target.kind === "tool" ? (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Input (JSON)</Label>
          <Textarea
            aria-label="Tool input JSON"
            rows={4}
            className="font-mono text-xs"
            placeholder={'{ "channel": "#alerts", "text": "{{title}}" }'}
            value={inputText}
            onChange={(e) => onChange(target, e.target.value)}
          />
          <p className="text-2xs text-muted-foreground">
            The tool's own arguments. {placeholders} are replaced with the notification's fields;
            any other {"{{…}}"} is refused, because it would be delivered as literal text.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// -- helpers --------------------------------------------------------------

interface Option {
  value: string;
  label: string;
}

/** The workspace's tools, plus a stored one it no longer has. */
function withCurrent(available: readonly string[], current: string): Option[] {
  const options = available.map((value) => ({ value, label: value }));
  if (current && !available.includes(current)) {
    options.unshift({ value: current, label: `${current} — no longer installed` });
  }
  return options;
}

/** The caller's automations, plus a stored one that is gone. */
function withCurrentAutomation(
  available: readonly { id: string; name: string }[],
  current: string,
): Option[] {
  const options = available.map((a) => ({ value: a.id, label: a.name }));
  if (current && !available.some((a) => a.id === current)) {
    options.unshift({ value: current, label: `${current} — no longer available` });
  }
  return options;
}

/** Drop the keys an "any" selection cleared, so an empty match stays empty. */
function prune(match: NotificationRouteMatch): NotificationRouteMatch {
  return {
    ...(match.source ? { source: match.source } : {}),
    ...(match.name ? { name: match.name } : {}),
    ...(match.level ? { level: match.level } : {}),
  };
}

/**
 * The draft as the write accepts it.
 *
 * `createdBy` and the raw `inputText` are dropped here: the first is stamped by
 * the server from the authenticated identity and refused in a body, the second
 * is editor state. A malformed JSON input throws rather than silently sending
 * an empty object — a route that quietly delivers nothing is the failure this
 * whole surface exists to make visible.
 */
function materialize(route: RouteDraft): NotificationRouteInput {
  return {
    ...(route.id ? { id: route.id } : {}),
    match: route.match,
    deliver: route.targets.map(({ target, inputText }) => {
      if (target.kind !== "tool") return target;
      const text = inputText.trim();
      if (text.length === 0) return { kind: "tool", tool: target.tool };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`The input for "${target.tool || "a target"}" is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`The input for "${target.tool || "a target"}" must be a JSON object.`);
      }
      return { kind: "tool", tool: target.tool, input: parsed as Record<string, unknown> };
    }),
  };
}
