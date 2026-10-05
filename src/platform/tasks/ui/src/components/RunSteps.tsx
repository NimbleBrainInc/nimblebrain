import { useEffect, useState } from "react";
import { StatusIcon } from "../icons.tsx";
import type { RunToolCall } from "../types.ts";
import { Section } from "./Section.tsx";

/** Steps shown before "Show all": enough to read the run's shape without a wall of rows. */
const FIRST_STEPS = 8;

/**
 * A tool call as a step a person reads: `hubspot__search_deals` is "Search
 * deals" in hubspot. The name keeps its source so two tools of the same name
 * stay apart.
 */
export function stepTitle(name: string): { action: string; source?: string } {
  const sep = name.indexOf("__");
  const source = sep > 0 ? name.slice(0, sep) : undefined;
  const raw = (sep > 0 ? name.slice(sep + 2) : name).replace(/[_-]+/g, " ").trim();
  const action = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : name;
  return { action, ...(source ? { source } : {}) };
}

/** Milliseconds as a step's duration: "340 ms", "2.4 s", "1m 05s". */
export function stepDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * How the run went, step by step: each tool call in plain words with how long
 * it took, a bar to compare durations, and its input and output behind
 * "Show details".
 */
export function RunSteps({ log }: { log: RunToolCall[] }) {
  const [all, setAll] = useState(false);
  if (log.length === 0) return null;
  const longest = Math.max(...log.map((tc) => tc.ms), 1);
  const failed = log.filter((tc) => !tc.ok).length;
  const shown = all ? log : log.slice(0, FIRST_STEPS);
  return (
    <Section
      title="Steps"
      aside={
        <span className="muted">
          {log.length} tool {log.length === 1 ? "call" : "calls"}
          {failed > 0 ? `, ${failed} failed` : ""}
        </span>
      }
    >
      <ol className="steps">
        {shown.map((tc) => {
          const { action, source } = stepTitle(tc.name);
          const tone = tc.ok ? "success" : "danger";
          return (
            <li key={tc.id} className={`step tone-${tone}`}>
              <span className="step-node">
                <StatusIcon tone={tone} />
              </span>
              <div className="step-main">
                <div className="step-line">
                  <span className="step-title">
                    {action}
                    {source && <span className="muted"> in {source}</span>}
                    {!tc.ok && <span className="tool-failed">failed</span>}
                  </span>
                  <span className="step-time num">{stepDuration(tc.ms)}</span>
                </div>
                <span className="step-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(2, (tc.ms / longest) * 100)}%` }} />
                </span>
                <details className="step-details">
                  <summary>Show details</summary>
                  <div className="tool-io">
                    <div className="sub-heading">
                      Tool <code>{tc.name}</code>
                    </div>
                    <div className="sub-heading">Input</div>
                    <pre>{JSON.stringify(tc.input, null, 2)}</pre>
                    <div className="sub-heading">Output</div>
                    <pre>{tc.output}</pre>
                  </div>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
      {log.length > FIRST_STEPS && (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${log.length} steps`}
        </button>
      )}
    </Section>
  );
}

/** Time since an instant, ticking each second: "1m 12s". */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ms = Math.max(0, now - new Date(since).getTime());
  return <span className="num">{stepDuration(Math.floor(ms / 1000) * 1000)}</span>;
}
