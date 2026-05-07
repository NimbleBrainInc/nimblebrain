import { useEffect, useState } from "react";
import {
  type ConnectorTool,
  getConnectorPermissions,
  type ToolPolicy,
  listConnectorTools,
  setConnectorPermissions,
} from "../../api/client";

/**
 * Per-tool permission table for an installed connector. Shows every
 * tool the connector exposes (read live from `tools/list`) with a
 * binary Allow / Disallow toggle and bulk "Allow all" / "Disallow all"
 * controls at the top.
 *
 * Defaults: tools without a recorded policy are treated as Allow. The
 * runtime gate at `ToolRegistry.execute` honors the same default,
 * so an empty permissions.json means "everything works." This matches
 * the trust-by-default posture; users tighten when needed.
 */
export function ToolPermissionsTable({
  serverName,
  scope,
}: {
  serverName: string;
  scope: "user" | "workspace";
}) {
  const [tools, setTools] = useState<ConnectorTool[]>([]);
  const [policies, setPolicies] = useState<Record<string, ToolPolicy>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingTool, setSavingTool] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [toolsRes, permsRes] = await Promise.all([
          listConnectorTools(serverName, scope),
          getConnectorPermissions(serverName, scope),
        ]);
        if (cancelled) return;
        setTools(toolsRes.tools);
        setPolicies(permsRes.tools);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverName, scope]);

  const policyFor = (toolName: string): ToolPolicy =>
    policies[toolName] === "disallow" ? "disallow" : "allow";

  const updatePolicy = async (toolName: string, next: ToolPolicy) => {
    setSavingTool(toolName);
    setError(null);
    const prev = policyFor(toolName);
    // Optimistic update
    setPolicies((p) => ({ ...p, [toolName]: next }));
    try {
      await setConnectorPermissions(serverName, scope, { [toolName]: next });
    } catch (err) {
      // Roll back on failure
      setPolicies((p) => ({ ...p, [toolName]: prev }));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTool(null);
    }
  };

  const updateAll = async (next: ToolPolicy) => {
    setError(null);
    const all: Record<string, ToolPolicy> = {};
    for (const t of tools) all[t.name] = next;
    const prev = { ...policies };
    setPolicies(all);
    try {
      await setConnectorPermissions(serverName, scope, all);
    } catch (err) {
      setPolicies(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading tools…</div>;
  }
  if (error) {
    return <div className="text-sm text-destructive">Failed to load tools: {error}</div>;
  }
  if (tools.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        This connector exposes no tools. Reconnect or wait for it to finish starting.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Tool permissions</h3>
          <p className="text-xs text-muted-foreground">
            Choose which tools your agent is allowed to call. Disallowed tools are blocked at the
            platform; the agent sees a structured error.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => updateAll("allow")}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
          >
            Allow all
          </button>
          <button
            type="button"
            onClick={() => updateAll("disallow")}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
          >
            Disallow all
          </button>
        </div>
      </div>

      <div className="border border-border rounded-md divide-y divide-border">
        {tools.map((tool) => {
          const policy = policyFor(tool.name);
          const summary = summarizeToolDescription(tool.description);
          return (
            <div key={tool.name} className="flex items-center justify-between gap-4 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{tool.name}</span>
                  {savingTool === tool.name && (
                    <span className="text-[10px] text-muted-foreground">saving…</span>
                  )}
                </div>
                {summary && (
                  <p
                    className="text-xs text-muted-foreground mt-0.5 truncate"
                    title={tool.description}
                  >
                    {summary}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <PolicyButton
                  active={policy === "allow"}
                  onClick={() => updatePolicy(tool.name, "allow")}
                  label="Allow"
                />
                <PolicyButton
                  active={policy === "disallow"}
                  onClick={() => updatePolicy(tool.name, "disallow")}
                  label="Disallow"
                  variant="destructive"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * MCP tool descriptions are written for the LLM, not for humans —
 * many run hundreds of words with embedded `<example>` blocks, JSON
 * schemas, and bullet lists. For the Configure UI, render only the
 * first sentence (or first line), strip XML-ish tags, and let the
 * full description live in the row's `title` tooltip.
 */
function summarizeToolDescription(raw: string | undefined): string {
  if (!raw) return "";
  // Take the first paragraph (first blank line / first newline run).
  const firstChunk = raw.split(/\n{2,}|\r\n\r\n/)[0]?.split(/\n/)[0] ?? "";
  // Drop XML-ish tags so things like <example>...</example> don't leak.
  const stripped = firstChunk
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // First sentence — fall back to truncated chunk if no sentence break.
  const sentenceMatch = stripped.match(/^.+?[.!?](?:\s|$)/);
  const sentence = sentenceMatch ? sentenceMatch[0].trim() : stripped;
  return sentence.length > 140 ? `${sentence.slice(0, 140).trimEnd()}…` : sentence;
}

function PolicyButton({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant?: "destructive";
}) {
  const base = "text-[11px] px-2 py-1 rounded border transition-colors";
  const inactiveColor = "border-border text-muted-foreground hover:bg-muted";
  const activeColor =
    variant === "destructive"
      ? "border-destructive bg-destructive/10 text-destructive"
      : "border-primary bg-primary/10 text-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${active ? activeColor : inactiveColor}`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
