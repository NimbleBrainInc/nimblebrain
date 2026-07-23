import { useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import type { SkillsLoadedContext } from "../hooks/useChat";
import { conciseReason, formatTokenCount, SCOPE_CLASS, shortSkillName } from "../lib/skill-display";
import { toSlug } from "../lib/workspace-slug";

/**
 * The skills projection of the Context Ledger — one quiet line at the top of an
 * assistant turn recording which skills the runtime composed into the prompt.
 *
 * A sibling of `.turn-pill`: text-only and muted at rest (fades into the page),
 * boxing up only when expanded into the "why did this load" drawer. Selection
 * happens at compose time, so this truthfully precedes all of the turn's work.
 *
 * Renders nothing when the turn loaded no skills — absence of the line is the
 * signal.
 */
export function LedgerLine({ skills }: { skills: SkillsLoadedContext | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const { activeWorkspace } = useWorkspaceContext();

  if (!skills || skills.skills.length === 0) return null;

  const entries = skills.skills;
  const count = entries.length;
  // Skills are workspace-scoped; "Manage" targets the focused workspace.
  const skillsPath = activeWorkspace ? `/w/${toSlug(activeWorkspace.id)}/settings/skills` : "/";

  const verb =
    count === 1 ? `Following ${shortSkillName(entries[0]!.id)}` : `Following ${count} skills`;
  // One skill → its (stripped) reason; many → the aggregate token cost.
  const meta =
    count === 1
      ? conciseReason(entries[0]!.reason)
      : `~${formatTokenCount(skills.totalTokens)} tokens`;

  return (
    <div className="ledger-line" data-expanded={expanded}>
      <button
        type="button"
        className="ledger-line__head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="ledger-line__dot" aria-hidden />
        <span className="ledger-line__verb">{verb}</span>
        {meta && <span className="ledger-line__meta">· {meta}</span>}
        <span className="ledger-line__chev" aria-hidden />
      </button>
      {expanded && (
        <div className="ledger-line__body">
          <div className="ledger-line__trust">
            Behavior guidance composed into the agent's instructions for this turn.
          </div>
          {entries.map((s) => (
            <div key={s.id} className="ledger-line__row">
              <span className="ledger-line__row-name">{shortSkillName(s.id)}</span>
              <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>{s.scope}</span>
              <span className="ledger-line__row-detail ledger-line__mono" title={s.reason}>
                {s.reason}
              </span>
              <span className="ledger-line__row-tok">{formatTokenCount(s.tokens)} tok</span>
            </div>
          ))}
          <div className="ledger-line__foot">
            <Link to={skillsPath}>Manage skills ↗</Link>
          </div>
        </div>
      )}
    </div>
  );
}
