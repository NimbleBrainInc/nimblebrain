import { useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import type { SkillsLoadedContext } from "../hooks/useChat";
import {
  conciseReason,
  formatTokenCount,
  SCOPE_CLASS,
  skillProvenanceLabel,
} from "../lib/skill-display";
import { toSlug } from "../lib/workspace-slug";
import { Disclosure } from "./Disclosure";

/**
 * The skills projection of the Context Ledger — one quiet line at the top of an
 * assistant turn recording which skills the runtime composed into the prompt.
 *
 * The skills variant of `<Disclosure>`, which it shares with the activity chip
 * stacked directly beneath it. Selection happens at compose time, so this
 * truthfully precedes all of the turn's work.
 *
 * Renders nothing when given nothing. The caller decides which turns are worth
 * a line — `ledgerChanges` withholds the payload on a turn whose equipment is
 * unchanged, so absence reads as "nothing new here", covering both "no skills"
 * and "the same skills as before".
 */
export function LedgerLine({ skills }: { skills: SkillsLoadedContext | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const { activeWorkspace } = useWorkspaceContext();

  if (!skills || skills.skills.length === 0) return null;

  const entries = skills.skills;
  const count = entries.length;
  // Skills are workspace-scoped; "Manage" targets the focused workspace.
  const skillsPath = activeWorkspace ? `/w/${toSlug(activeWorkspace.id)}/settings/skills` : "/";

  const verb = count === 1 ? `Using ${entries[0]!.name}` : `Using ${count} skills`;
  // One skill → its (stripped) reason; many → the aggregate token cost.
  const meta =
    count === 1
      ? conciseReason(entries[0]!.reason)
      : `~${formatTokenCount(skills.totalTokens)} tokens`;

  return (
    <Disclosure
      variant="ledger-line"
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      glyph={<span className="disclosure__dot" aria-hidden />}
      body={
        <>
          <div className="ledger-line__trust">
            Behavior guidance composed into the agent's instructions for this turn.
          </div>
          {entries.map((s) => (
            <div key={s.id} className="ledger-line__row">
              <span className="ledger-line__row-name">{s.name}</span>
              <span className={`ledger-line__scope ${SCOPE_CLASS[s.scope]}`}>
                {skillProvenanceLabel(s)}
              </span>
              <span className="ledger-line__row-detail ledger-line__mono" title={s.reason}>
                {s.reason}
              </span>
              <span className="ledger-line__row-tok">{formatTokenCount(s.tokens)} tok</span>
            </div>
          ))}
          <div className="ledger-line__foot">
            <Link to={skillsPath}>Manage skills ↗</Link>
          </div>
        </>
      }
    >
      <span className="ledger-line__verb">{verb}</span>
      {meta && <span className="ledger-line__meta">· {meta}</span>}
    </Disclosure>
  );
}
