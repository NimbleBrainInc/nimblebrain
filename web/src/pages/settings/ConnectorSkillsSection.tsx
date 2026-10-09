import { useEffect, useId, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import { approxTokens } from "../../_generated/skill-tokens";
import {
  type ConnectorOverlaySkill,
  listConnectorSkills,
  type PublishedConnectorSkill,
  readConnectorSkill,
} from "../../api/client";
import { formatTokenCount, skillMechanismLabel } from "../../lib/skill-display";
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
  /** How it reaches the model, in the settings list's resting grammar. */
  loads: { text: string; mono?: string };
  /** Facts shown under the body: priority, triggers, URI, provenance. */
  details: string[];
}

/**
 * The rows for one workspace's connector skills, grouped by server in name
 * order. An overlay is delivered once into the conversation on the first call
 * to a tool it is bound to; a published skill loads as the runtime's own
 * mechanism verdict says.
 */
export function connectorSkillGroups(data: {
  overlays: ConnectorOverlaySkill[];
  published: PublishedConnectorSkill[];
}): Array<{ server: string; skills: ConnectorSkillRowData[] }> {
  const rows: ConnectorSkillRowData[] = [
    ...data.overlays.map(
      (o): ConnectorSkillRowData => ({
        server: o.server,
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        kind: "overlay",
        loads: { text: "On first tool call", mono: o.toolAffinity.join(", ") },
        details: ["curated overlay", ...(o.source ? [o.source] : [])],
      }),
    ),
    ...data.published.map(
      (p): ConnectorSkillRowData => ({
        server: p.server,
        name: p.name,
        description: p.description,
        kind: "published",
        loads: skillMechanismLabel({
          loading: { mechanism: p.mechanism },
          toolAffinity: p.toolAffinity,
          triggers: p.triggers,
        }) ?? { text: p.loadingStrategy },
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
 * Settings → Skills, workspace vantage: every skill the workspace's connected
 * servers put into the agent's context, read-only. They ship with the server,
 * so the only thing to do here is read them. The parent keys this by
 * workspace, and every read names the workspace it was opened on.
 */
export function ConnectorSkillsSection({ workspaceId }: { workspaceId: string }) {
  const [groups, setGroups] = useState<ReturnType<typeof connectorSkillGroups> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});

  useEffect(() => {
    let cancelled = false;
    listConnectorSkills(workspaceId)
      .then((data) => {
        if (!cancelled) setGroups(connectorSkillGroups(data));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load connector skills.");
        setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

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
    <Section
      title="From connectors"
      description="Skills your connected servers put into the agent's context. They ship with the server, so they are read-only here."
    >
      {groups === null && <p className="py-2 text-sm text-muted-foreground">Loading…</p>}
      {error && <InlineError message={error} />}
      {groups !== null && !error && groups.length === 0 && (
        <EmptyState message="No connected server publishes skills in this workspace." />
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
            title={row.loads.mono ? `${row.loads.text} ${row.loads.mono}` : row.loads.text}
            className="mt-0.5 block truncate text-xs text-muted-foreground"
          >
            {row.loads.text}
            {row.loads.mono && (
              <>
                {" "}
                <span className="font-mono">{row.loads.mono}</span>
              </>
            )}
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
