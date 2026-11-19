import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import { listConnectorSkills, listPlugins } from "../api/client";
import {
  HEADER_ACTION,
  HEADER_ACTION_LABEL,
  ListEmpty,
  ListPageHeader,
  ROW_LINK,
  ROW_TEXT,
  RowMenu,
  SegmentBar,
} from "../components/plugins/list-parts";
import { SkillHereSwitch } from "../components/plugins/SkillHereSwitch";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { type AuthoredSkill, listAuthoredSkills } from "../lib/authored-skills";
import {
  buildSkillsModel,
  defaultSegment,
  type PluginSkillRow,
  type Segment,
} from "../lib/plugin-lists";
import { newSkillPath, pluginPath, skillPath } from "../lib/plugins";
import { type SkillMechanismInput, skillLoadsText } from "../lib/skill-display";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { InlineError } from "./settings/components";

/**
 * Skills — what the agent is taught in this workspace, at `/w/:slug/skills`.
 *
 * **Workspace** lists the skills that apply to everyone here: the workspace's
 * and the org's (an org skill is tagged, and changed in org settings).
 * **Personal** lists the viewer's own, which apply in every workspace unless
 * turned off in one, so each enabled one carries an On here switch. Beneath either, a muted group
 * lists the skills that came with the segment's plugins acting here; each opens
 * its plugin's page, where it is read. New skill writes one, for the viewer
 * alone or everyone here.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function SkillsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const wsId = toWsId(slug);
  const navigate = useNavigate();
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-5">
        <ListPageHeader
          title="Skills"
          action={
            <Button
              type="button"
              size="sm"
              className={HEADER_ACTION}
              aria-label="New skill"
              onClick={() => navigate(newSkillPath(slug))}
              data-testid="skills-new"
              data-tour="skills"
            >
              <Plus aria-hidden />
              <span className={HEADER_ACTION_LABEL}>New skill</span>
            </Button>
          }
        />
        <SkillsList key={wsId} wsId={wsId} slug={slug} />
      </div>
    </div>
  );
}

/** How a plugin's skill loads, keyed by server and name. */
type LoadsByKey = ReadonlyMap<string, SkillMechanismInput>;
const loadsKey = (server: string, name: string) => `${server}\u0000${name}`;

function SkillsList({ wsId, slug }: { wsId: string; slug: string }) {
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const [skills, setSkills] = useState<AuthoredSkill[] | null>(null);
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [loads, setLoads] = useState<LoadsByKey>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [chosenSegment, setChosenSegment] = useState<Segment | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    listAuthoredSkills(wsId).then(
      (next) => !cancelled && setSkills(next),
      (err: unknown) => {
        if (cancelled) return;
        setError(message(err));
        setSkills([]);
      },
    );
    listPlugins(wsId).then(
      (next) => !cancelled && setPlugins(next.plugins),
      (err: unknown) => {
        if (cancelled) return;
        setPluginsError(message(err));
        setPlugins([]);
      },
    );
    // When each plugin skill loads. A row without it still names its plugin.
    listConnectorSkills(wsId).then(
      (data) => {
        if (cancelled) return;
        const next = new Map<string, SkillMechanismInput>();
        for (const o of data.overlays) {
          next.set(loadsKey(o.server, o.name), { loading: { mechanism: "tool_affinity" } });
        }
        for (const p of data.published) {
          next.set(loadsKey(p.server, p.name), {
            loading: { mechanism: p.mechanism },
            ...(p.triggers ? { triggers: p.triggers } : {}),
          });
        }
        setLoads(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  const counts = useMemo(
    () =>
      skills ? buildSkillsModel(skills, [], { segment: "workspace", query: "" }).counts : null,
    [skills],
  );
  const segment: Segment = chosenSegment ?? defaultSegment(counts);
  const model = useMemo(
    () => (skills && plugins ? buildSkillsModel(skills, plugins, { segment, query }) : null),
    [skills, plugins, segment, query],
  );

  if (!model) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const searching = query.trim().length > 0;

  return (
    <div className="space-y-4">
      <SegmentBar
        segment={segment}
        onSegment={setChosenSegment}
        counts={model.counts}
        query={query}
        onQuery={setQuery}
        searchLabel="Search skills"
      />

      {error && <InlineError message={`Unable to load skills: ${error}`} />}

      {model.rows.length === 0 ? (
        <ListEmpty>
          {searching
            ? `No skills match "${query.trim()}".`
            : segment === "workspace"
              ? `${workspaceName} has no skills for everyone yet.`
              : "You have no skills of your own yet. New skill writes one for just you."}
        </ListEmpty>
      ) : (
        <div data-testid="skill-list" data-segment={segment}>
          {model.rows.map((skill) => (
            <SkillRow
              key={`${skill.scope}:${skill.id}`}
              skill={skill}
              loads={skillLoadsText(skill, plugins ?? [])}
              to={skillPath(slug, skill.scope, skill.name)}
              control={
                segment === "personal" && skill.status === "active" ? (
                  <SkillHereSwitch
                    skill={skill}
                    workspaceId={wsId}
                    onChange={(onHere) =>
                      setSkills(
                        (prev) =>
                          prev?.map((s) =>
                            s.scope === "user" && s.id === skill.id ? { ...s, onHere } : s,
                          ) ?? prev,
                      )
                    }
                  />
                ) : null
              }
            />
          ))}
        </div>
      )}

      {pluginsError && <InlineError message={`Unable to load plugins: ${pluginsError}`} />}
      {model.fromPlugins.length > 0 && (
        <section
          className="pt-3"
          data-testid="skills-from-plugins"
          aria-labelledby="skills-from-plugins-title"
        >
          <h2
            id="skills-from-plugins-title"
            className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
          >
            From your plugins
          </h2>
          <div>
            {model.fromPlugins.map((row) => (
              <PluginSkillRowView
                key={`${row.plugin.id}:${row.skill.serverName}:${row.skill.name}`}
                row={row}
                to={pluginPath(slug, row.plugin)}
                loads={pluginSkillLoads(
                  row,
                  loads.get(loadsKey(row.skill.serverName, row.skill.name)),
                )}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const ROW =
  "relative flex min-h-11 items-center gap-3 border-b border-border/60 py-1.5 last:border-b-0";

/**
 * When a plugin's skill loads. Its tool patterns can reach only its own
 * server's tools (the runtime prefixes them with the server's name, whatever
 * the plugin's owner), so a tool-bound one loads when its plugin is used. An
 * overlay is always tool-bound, listed or not.
 */
function pluginSkillLoads(
  row: PluginSkillRow,
  input: SkillMechanismInput | undefined,
): string | null {
  const toolBound = input
    ? input.loading?.mechanism === "tool_affinity"
    : row.skill.kind === "overlay";
  if (toolBound) return `When ${row.plugin.displayName} is used`;
  return input ? skillLoadsText(input, []) : null;
}

/**
 * One skill someone wrote: its name, an Org tag on the org's, when it loads
 * (unless it loads only when the agent asks, the default), the On here switch
 * on the viewer's own, and its ⋯ menu. A disabled skill reads muted and says
 * only Disabled, with no switch: it applies nowhere, so here is moot. One off
 * here reads muted and says Off here. The whole row opens the skill's page.
 */
function SkillRow({
  skill,
  loads,
  to,
  control,
}: {
  skill: AuthoredSkill;
  loads: string | null;
  to: string;
  control: React.ReactNode;
}) {
  const disabled = skill.status !== "active";
  // Turned off in this workspace by its owner (On here), though on elsewhere.
  const offHere = !disabled && skill.onHere === false;
  return (
    <div
      className={ROW}
      data-testid="skill-row"
      data-skill-scope={skill.scope}
      data-skill-name={skill.name}
    >
      <div className={ROW_TEXT}>
        <span className="flex min-w-0 items-baseline gap-2">
          <Link
            to={to}
            className={cn(
              "min-w-0 truncate text-sm",
              (disabled || offHere) && "text-muted-foreground",
              ROW_LINK,
            )}
          >
            {skill.name}
          </Link>
          {skill.scope === "org" && (
            <Badge variant="outline" className="relative" data-testid="skill-org-tag">
              Org
            </Badge>
          )}
        </span>
        {loads && (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="skill-facts"
          >
            {loads}
          </span>
        )}
      </div>
      {(disabled || offHere) && (
        <span className="relative shrink-0 text-xs text-muted-foreground" data-testid="skill-state">
          {disabled ? "Disabled" : "Off here"}
        </span>
      )}
      {!disabled && control && <div className="relative shrink-0">{control}</div>}
      <RowMenu
        name={skill.name}
        items={[{ kind: "link", label: "Open", to }]}
        testId="skill-menu"
      />
    </div>
  );
}

/** A skill that came with a plugin: its name, its plugin, and when it loads; it opens the plugin. */
function PluginSkillRowView({
  row,
  to,
  loads,
}: {
  row: PluginSkillRow;
  to: string;
  loads: string | null;
}) {
  const { skill, plugin } = row;
  return (
    <div
      className={ROW}
      data-testid="plugin-skill-row"
      data-skill-name={skill.name}
      data-plugin-id={plugin.id}
    >
      <div className={ROW_TEXT}>
        <Link to={to} className={cn("min-w-0 truncate text-sm text-muted-foreground", ROW_LINK)}>
          {skill.name}
        </Link>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {plugin.displayName}
          {loads && ` · ${loads}`}
        </span>
      </div>
      <RowMenu
        name={skill.name}
        items={[{ kind: "link", label: `Open ${plugin.displayName}`, to }]}
        testId="plugin-skill-menu"
      />
    </div>
  );
}
