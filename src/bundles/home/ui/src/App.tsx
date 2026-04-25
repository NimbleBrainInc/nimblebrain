import {
  SynapseProvider,
  useDataSync,
  useHostContext,
  useSynapse,
} from "@nimblebrain/synapse/react";
import { useCallback, useEffect, useState } from "react";

/* ---------- types ---------- */

interface BriefingOutput {
  greeting: string;
  date: string;
  lede: string;
  sections: BriefingSection[];
  state: "empty" | "quiet" | "all-clear" | "normal" | "attention";
  generated_at: string;
  cached: boolean;
}

interface BriefingSection {
  id: string;
  text: string;
  type: "positive" | "neutral" | "warning";
  category: "recent" | "upcoming" | "attention";
  action?: BriefingAction;
}

interface BriefingAction {
  label: string;
  type: string;
  [key: string]: unknown;
}

/* ---------- helpers ---------- */

function getGreeting(userName?: string): string {
  const h = new Date().getHours();
  const name = userName || "";
  const prefix = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${prefix}, ${name}` : prefix;
}

function getDateStr(timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  if (timezone) opts.timeZone = timezone;
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date());
  }
}

function dotColor(sentiment: string): string {
  if (sentiment === "positive") return "var(--nb-color-success, #059669)";
  if (sentiment === "warning") return "var(--nb-color-danger, #dc2626)";
  return "var(--nb-color-warning, #f59e0b)";
}

function renderMd(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/* ---------- raw tool call (cross-server, bypasses Synapse SDK routing) ---------- */

let _rpcId = 0;
const _pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || !msg.jsonrpc || !msg.id) return;
  const p = _pending.get(msg.id);
  if (!p) return;
  _pending.delete(msg.id);
  if (msg.error) {
    p.reject(new Error(msg.error.message || "Tool call failed"));
  } else {
    p.resolve(msg.result);
  }
});

function rawToolCall<T>(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const id = `home-${++_rpcId}`;
  return new Promise((resolve, reject) => {
    _pending.set(id, {
      resolve: (raw) => {
        const result = raw as { structuredContent?: Record<string, unknown> };
        resolve((result?.structuredContent ?? raw) as T);
      },
      reject,
    });
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id,
        params: { server, name: tool, arguments: args },
      },
      "*",
    );
    setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        reject(new Error("Tool call timed out"));
      }
    }, 60000);
  });
}

/* ---------- components ---------- */

function Skeleton() {
  return (
    <div style={{ marginTop: 24 }}>
      <div className="skel skel-divider" />
      <div className="skel skel-item" />
      <div className="skel skel-item" />
    </div>
  );
}

function SectionGroup({
  label,
  items,
  onAction,
}: {
  label: string;
  items: BriefingSection[];
  onAction: (action: BriefingAction) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="section-divider">{label}</div>
      {items.map((item) => (
        <div key={item.id} className="section-item">
          <span className="dot" style={{ background: dotColor(item.type) }} />
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown rendered from trusted briefing data */}
          <span className="item-text" dangerouslySetInnerHTML={{ __html: renderMd(item.text) }} />
          {item.action && (
            <button
              type="button"
              className="item-action"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "inherit",
                font: "inherit",
              }}
              onClick={() => {
                onAction(item.action!);
              }}
            >
              {item.action.label || "View"} &rarr;
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function Dashboard() {
  const synapse = useSynapse();
  // The host publishes the active workspace as `hostContext.workspace` on
  // every workspace switch. Keying the briefing fetch on `workspace.id`
  // refetches the (workspace-scoped) briefing without remounting this iframe.
  // Narrow to both id and name even though only id drives refetch — keeps
  // future briefing copy ("Switched to Acme") cheap to wire up.
  const { workspace } = useHostContext<{ workspace?: { id: string; name: string } }>();
  const workspaceId = workspace?.id;
  const [briefing, setBriefing] = useState<BriefingOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);

  const loadBriefing = useCallback(async (forceRefresh = false) => {
    setError(null);
    setStale(false);
    setLoading(true);
    try {
      // Use raw postMessage to call nb__briefing on the "nb" server.
      // The Synapse SDK's callTool routes to the app's own server ("home"),
      // but briefing lives on the "nb" inline source. Internal apps can
      // specify params.server to cross-call.
      const result = await rawToolCall(
        "nb",
        "briefing",
        forceRefresh ? { force_refresh: true } : {},
      );
      if (result) setBriefing(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load briefing");
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the active workspace lands or changes. The host bridge
  // sends `host-context-changed` with the new workspace id; the SDK exposes
  // it via `useHostContext`. `loadBriefing` is stable so it isn't a dep —
  // `workspaceId` is the only meaningful trigger.
  //
  // Skip the first render where `workspaceId` is undefined: the
  // `useHostContext` value lands on the next render after the handshake
  // resolves. Without the guard we'd fire one wasted briefing fetch in the
  // handshake-window, then immediately fire again with the real id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId is the refetch trigger; loadBriefing is stable
  useEffect(() => {
    if (!workspaceId) return;
    loadBriefing();
  }, [workspaceId]);

  // Show refresh banner on data changes
  useDataSync(() => {
    setStale(true);
  });

  const handleAction = useCallback(
    (action: BriefingAction) => {
      const { type, label: _label, ...params } = action;
      synapse.action(type, params);
    },
    [synapse],
  );

  const categories: Array<{
    key: string;
    label: string;
  }> = [
    { key: "attention", label: "Needs attention" },
    { key: "recent", label: "Recent" },
    { key: "upcoming", label: "Coming up" },
  ];

  const greeting = briefing?.greeting || getGreeting();
  const date = briefing?.date || getDateStr();

  return (
    <div className="page">
      {/* Refresh banner */}
      {stale && (
        <div className="refresh-banner visible">
          <span>New activity available</span>
          <button type="button" onClick={() => loadBriefing(true)}>
            Refresh
          </button>
        </div>
      )}

      {/* Always-visible header */}
      <div className="greeting">{greeting}</div>
      <div className="date">{date}</div>

      {/* Loading state */}
      {loading && !briefing && !error && (
        <>
          <p className="lede">Generating your daily briefing&hellip;</p>
          <Skeleton />
        </>
      )}

      {/* Error state */}
      {error && (
        <div className="error-box">
          <p>{error}</p>
          <button type="button" className="retry-btn" onClick={() => loadBriefing()}>
            Retry
          </button>
        </div>
      )}

      {/* Briefing content */}
      {briefing && (
        <>
          {briefing.lede && <p className="lede">{briefing.lede}</p>}
          {categories.map(({ key, label }) => (
            <SectionGroup
              key={key}
              label={label}
              items={(briefing.sections || []).filter((s) => s.category === key)}
              onAction={handleAction}
            />
          ))}
        </>
      )}
    </div>
  );
}

/* ---------- root ---------- */

export function App() {
  return (
    <SynapseProvider name="@nimblebraininc/home" version="0.1.0">
      <Dashboard />
    </SynapseProvider>
  );
}
