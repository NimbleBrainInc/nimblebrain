import { useEffect, useState } from "react";
import {
  type ConnectorTool,
  listConnectorToolsWithPermissions,
  type ToolPolicy,
  setConnectorPermissions,
} from "../../api/client";

/**
 * Per-tool permission table for an installed connector. Reads every
 * tool the connector exposes (live `tools/list`) and pairs each with
 * a binary Allow / Disallow control. Bulk "Allow all" / "Disallow
 * all" sit in the section header for the I-just-want-everything-on /
 * everything-off cases.
 *
 * Defaults: tools without a recorded policy are treated as Allow.
 * The runtime gate at `ToolRegistry.execute` honors the same default,
 * so an empty permissions.json means "everything works." Trust-by-
 * default; users tighten when needed.
 *
 * Visual treatment is intentionally light — no surrounding box, just
 * row dividers — because this table is the longest scroll context on
 * a Configure page with 10+ tools. A heavy border made the page feel
 * walled off; lighter chrome lets it sit alongside the other sections.
 */
export function ToolPermissionsTable({
  serverName,
  mode: _mode,
}: {
  serverName: string;
  /**
   * UI affordance — which settings page is rendering us. The REST
   * helpers always read/write workspace-scope permissions (Stage 2:
   * personal connectors live in the user's personal workspace,
   * addressed by setting it active before navigating here).
   */
  mode: "personal" | "workspace";
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
        // Single combined call replaces the previous two-call shape
        // (list_tools + get_permissions). Server-side runs the two
        // reads in parallel; this halves the page-load REST traffic
        // for the table.
        const res = await listConnectorToolsWithPermissions(serverName, "workspace");
        if (cancelled) return;
        setTools(res.tools);
        setPolicies(res.permissions);
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
  }, [serverName]);

  const policyFor = (toolName: string): ToolPolicy =>
    policies[toolName] === "disallow" ? "disallow" : "allow";

  const updatePolicy = async (toolName: string, next: ToolPolicy) => {
    setSavingTool(toolName);
    setError(null);
    const prev = policyFor(toolName);
    setPolicies((p) => ({ ...p, [toolName]: next }));
    try {
      await setConnectorPermissions(serverName, "workspace", { [toolName]: next });
    } catch (err) {
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
      await setConnectorPermissions(serverName, "workspace", all);
    } catch (err) {
      setPolicies(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Stable header — present before / during / after load — so the
  // section heading doesn't pop in late and shift layout.
  const header = (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Tool permissions
        </h2>
        <p className="text-xs text-muted-foreground mt-1">Choose which tools the agent can call.</p>
      </div>
      {tools.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => updateAll("allow")}
            className="hover:text-foreground hover:underline underline-offset-4"
          >
            Allow all
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => updateAll("disallow")}
            className="hover:text-foreground hover:underline underline-offset-4"
          >
            Disallow all
          </button>
        </div>
      )}
    </div>
  );

  // Don't render the section when there are no tools to show. A
  // connector in `not_authenticated` (or any state without an
  // active source) returns empty tools — the hero already conveys
  // the "Sign-in required / Configure" prompt; an empty Tool
  // permissions section adds noise. Same for genuine zero-tool
  // bundles (rare). After load, only render with content.
  if (!loading && !error && tools.length === 0) return null;

  return (
    <section className="space-y-3">
      {header}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading tools…</p>
      ) : error ? (
        <p className="text-sm text-destructive">Failed to load tools: {error}</p>
      ) : (
        <ul className="border-t border-border/60">
          {tools.map((tool) => {
            const policy = policyFor(tool.name);
            const summary = summarizeToolDescription(tool.description);
            return (
              <li
                key={tool.name}
                className="flex items-center justify-between gap-4 py-2.5 border-b border-border/60"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono">{tool.name}</span>
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
                <PolicyToggle
                  policy={policy}
                  onAllow={() => updatePolicy(tool.name, "allow")}
                  onDisallow={() => updatePolicy(tool.name, "disallow")}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Two icon buttons — Allow (✓) and Disallow (⊘) — with the active one
 * filled. Replaces the previous Allow/Disallow word buttons; on a
 * Configure page with 10+ tools the word version dominated the
 * right edge and made every row scream "interactive." Icons are quiet
 * by default and pop only when active.
 */
function PolicyToggle({
  policy,
  onAllow,
  onDisallow,
}: {
  policy: ToolPolicy;
  onAllow: () => void;
  onDisallow: () => void;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <PolicyButton
        active={policy === "allow"}
        onClick={onAllow}
        ariaLabel="Allow"
        variant="allow"
      />
      <PolicyButton
        active={policy === "disallow"}
        onClick={onDisallow}
        ariaLabel="Disallow"
        variant="disallow"
      />
    </div>
  );
}

function PolicyButton({
  active,
  onClick,
  ariaLabel,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
  variant: "allow" | "disallow";
}) {
  // Active states use the brand / destructive tints at low alpha so
  // they read as "selected" without screaming. Inactive is a quiet
  // outlined square that hovers to a muted fill — enough hint that
  // it's clickable.
  const activeCls =
    variant === "allow"
      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : "border-rose-500/60 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  const inactiveCls = "border-border text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      title={ariaLabel}
      className={`h-7 w-7 flex items-center justify-center rounded border transition-colors ${
        active ? activeCls : inactiveCls
      }`}
    >
      {variant === "allow" ? <CheckIcon /> : <DenyIcon />}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path
        d="M2.5 6.5L5 9L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function DenyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M3 9L9 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
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
