import { useEffect, useId, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { approxTokens } from "../../_generated/skill-tokens";
import {
  type ConnectorOverlaySkill,
  listConnectorSkills,
  type PublishedConnectorSkill,
  readConnectorSkill,
} from "../../api/client";
import { formatTokenCount, pluginSkillLoadsText } from "../../lib/skill-display";
import { linkSafety, rehypePlugins } from "../../lib/streamdown-config";
import { cn } from "../../lib/utils";
import { EmptyState, InlineError, Section } from "./components";

/**
 * One skill a connector contributes, in the shape this section renders: a
 * curated overlay or a skill the server publishes. Both are keyed by server and
 * name, which is how `read_bound_skill` addresses them.
 */
export interface ConnectorSkillRowData {
  server: string;
  name: string;
  description?: string;
  kind: "overlay" | "published";
  /** When it reaches the model, in the reader's words (`pluginSkillLoadsText`). */
  loads: string;
  /** Facts shown under the body: priority, triggers, URI, provenance. */
  details: string[];
}

/**
 * The rows for one workspace's connector skills, grouped by server in name
 * order. An overlay is delivered once into the conversation on the first call
 * to a tool it is bound to; a published skill loads as the runtime's own
 * mechanism verdict says. `servers` are the plugin's whose page this is, so
 * its tools are named by their short names.
 */
export function connectorSkillGroups(
  data: {
    overlays: ConnectorOverlaySkill[];
    published: PublishedConnectorSkill[];
  },
  servers: readonly string[],
): Array<{ server: string; skills: ConnectorSkillRowData[] }> {
  const rows: ConnectorSkillRowData[] = [
    ...data.overlays.map(
      (o): ConnectorSkillRowData => ({
        server: o.server,
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        kind: "overlay",
        loads: pluginSkillLoadsText({ overlay: true, toolAffinity: o.toolAffinity }, servers) ?? "",
        details: ["curated overlay", ...(o.source ? [o.source] : [])],
      }),
    ),
    ...data.published.map(
      (p): ConnectorSkillRowData => ({
        server: p.server,
        name: p.name,
        description: p.description,
        kind: "published",
        loads:
          pluginSkillLoadsText(
            {
              loading: { mechanism: p.mechanism },
              toolAffinity: p.toolAffinity,
              triggers: p.triggers,
            },
            servers,
          ) ?? p.loadingStrategy,
        details: [
          `priority ${p.priority}`,
          ...(p.triggers?.length ? [`triggers ${p.triggers.map((t) => `"${t}"`).join(", ")}`] : []),
          p.uri,
        ],
      }),
    ),
  ];
  const byServer = new Map<string, ConnectorSkillRowData[]>();
  for (const row of rows) {
    const list = byServer.get(row.server) ?? [];
    list.push(row);
    byServer.set(row.server, list);
  }
  return [...byServer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, skills]) => ({
      server,
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

type BodyState =
  | { status: "loading" }
  | { status: "ok"; body: string }
  | { status: "error"; message: string };

const rowKey = (row: { server: string; name: string }) => `${row.server}\u0000${row.name}`;

/**
 * A plugin's skills, on its page: every skill the plugin's `servers` put into
 * the agent's context, read-only. They ship with the server, so the only thing
 * to do here is read them. Every read names the workspace it was opened on.
 */
export function ConnectorSkillsSection({
  workspaceId,
  servers,
}: {
  workspaceId: string;
  servers: readonly string[];
}) {
  const serverKey = servers.join("\u0000");
  const [groups, setGroups] = useState<ReturnType<typeof connectorSkillGroups> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});

  useEffect(() => {
    let cancelled = false;
    listConnectorSkills(workspaceId)
      .then((data) => {
        if (cancelled) return;
        const only = serverKey.split("\u0000");
        setGroups(connectorSkillGroups(data, only).filter((g) => only.includes(g.server)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load connector skills.");
        setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, serverKey]);

  const openRow = useMemo(
    () => groups?.flatMap((g) => g.skills).find((s) => rowKey(s) === openKey) ?? null,
    [groups, openKey],
  );
  const needsBody = openKey !== null && bodies[openKey]?.status !== "ok";

  // Fetch a body when its row opens and none is loaded yet. A read cut short
  // by closing the row, or one that failed, runs again on the next open; a
  // read that lands after the row closed or the section unmounted is dropped.
  useEffect(() => {
    if (!openRow || !openKey || !needsBody) return;
    let cancelled = false;
    const key = openKey;
    setBodies((prev) => ({ ...prev, [key]: { status: "loading" } }));
    readConnectorSkill(workspaceId, openRow.server, openRow.name)
      .then(({ body }) => {
        if (!cancelled) setBodies((prev) => ({ ...prev, [key]: { status: "ok", body } }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to read the skill.";
        setBodies((prev) => ({ ...prev, [key]: { status: "error", message } }));
      });
    return () => {
      cancelled = true;
    };
  }, [openKey, openRow, workspaceId, needsBody]);

  return (
    // A plugin's page rules its sections itself, so the section brings no rule of its own there.
    <Section
      flush
      title="Skills"
      description="Guidance this plugin puts into the agent's context. It ships with the plugin, so it is read-only here."
    >
      {groups === null && <p className="py-2 text-sm text-muted-foreground">Loading…</p>}
      {error && <InlineError message={error} />}
      {groups !== null && !error && groups.length === 0 && (
        <EmptyState message="This plugin brings no skills." />
      )}
      {groups !== null && groups.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
          {groups.map((group) => (
            <div key={group.server} className="divide-y divide-border">
              <h4 className="bg-secondary/40 px-3.5 py-2 font-mono text-2xs font-semibold text-muted-foreground">
                {group.server}
              </h4>
              {group.skills.map((row) => {
                const key = rowKey(row);
                return (
                  <ConnectorSkillRow
                    key={key}
                    row={row}
                    expanded={openKey === key}
                    body={openKey === key ? bodies[key] : undefined}
                    onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ConnectorSkillRow({
  row,
  expanded,
  body,
  onToggle,
}: {
  row: ConnectorSkillRowData;
  expanded: boolean;
  body: BodyState | undefined;
  onToggle: () => void;
}) {
  const bodyId = useId();
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-secondary",
          "focus-visible:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        )}
      >
        <span
          aria-hidden
          className="h-8 w-0.5 shrink-0 rounded-full"
          style={{ background: "var(--scope-connector)" }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-snug text-foreground">
            <span className="font-mono">{row.name}</span>
            {row.description && <span className="text-muted-foreground"> · {row.description}</span>}
          </span>
          <span
            title={row.loads}
            className="mt-0.5 block truncate text-xs text-muted-foreground"
            data-testid="connector-skill-loads"
          >
            {row.loads}
          </span>
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="px-3.5 pt-1 pb-3 pl-6">
          {body?.status === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}
          {body?.status === "error" && <InlineError message={body.message} />}
          {body?.status === "ok" && (
            <div className="max-w-prose text-sm text-foreground/80">
              <Streamdown
                className="streamdown-container"
                linkSafety={linkSafety}
                rehypePlugins={rehypePlugins}
              >
                {body.body}
              </Streamdown>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {body?.status === "ok" && (
              <span>~{formatTokenCount(approxTokens(body.body))} tokens</span>
            )}
            {row.details.map((d) => (
              <span key={d} className={d.includes("://") ? "font-mono" : undefined}>
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
