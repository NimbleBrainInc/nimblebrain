/**
 * Which tool names an unattended dispatch refuses.
 *
 * An unattended call has no human in the loop and no model deciding what to
 * name — the name comes from stored configuration. So the two things that keep
 * a scheduled run inside its lane have to be spelled differently here:
 *
 *   - **A run has surfacing.** `executeTask` filters the tool list it shows the
 *     model, and `surfaceTools` drops every `INTERNAL_TOOL_ANNOTATION`
 *     tool from it. Neither is a boundary — an internal tool stays callable by
 *     name, deliberately, because the web shell reaches it that way.
 *   - **A single dispatch has none.** There is no list, so a name that
 *     surfacing would have hidden arrives at the door regardless. What the
 *     dispatch refuses has to be stated, not inherited from a listing it never
 *     builds.
 *
 * The set is one rule: **a surface that grows the principal's future
 * capability**. A new automation fires again later as them; a new skill loads
 * itself into their later sessions; a connector install adds tools and
 * credentials that were not reachable before. Reaching any of those is how an
 * unattended call would widen its own reach, which is the foothold the
 * unattended wall exists to deny. That is narrower than "changes something
 * durable", which is true of every write tool and would bar most of them.
 * Everything else an unattended caller may name, subject to the gates every
 * door applies (`assertToolAllowed`, the personal-connector grant, the
 * workspace wall).
 *
 * The first two arms are the SAME predicates `executeTask` subtracts with, not
 * a copy of their policy: a tool added to either namespace is barred here on
 * the day it is added, because both are allowlists that fail closed.
 *
 * This is a name policy and nothing more, and it is only half the boundary. The
 * other half is ambient: a source refuses its own barred tools whenever
 * `RequestContext.unattended` is set, whatever router dispatched the call —
 * which is why `instructions__write_instructions` needs no entry here despite
 * matching the rule exactly (`checkWritePermission` refuses it before every
 * other gate). What the names buy is an answer of "denied" up front, from the
 * policy, instead of a source-specific error raised three layers down.
 */

import { isTaskForbiddenIdentityTool } from "./identity-sources.ts";
import { isTaskForbiddenSkillTool } from "./platform/skills.ts";

/**
 * Wire names barred outright, beyond the two namespace predicates.
 *
 * `nb__manage_connectors` installs and disconnects connectors and drives the
 * OAuth handshakes behind them, so reaching it unattended is how a dispatch
 * would acquire capabilities its principal never granted it. It carries
 * `INTERNAL_TOOL_ANNOTATION`, which keeps it out of every listing — the
 * reason a scheduled run has never needed it named here, and the reason a
 * dispatch does.
 */
const UNATTENDED_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set(["nb__manage_connectors"]);

/**
 * Whether a bare `<source>__<tool>` wire name is barred from an unattended
 * dispatch. See the module doc for the rule; `false` for every name outside
 * the three surfaces, which is most of them.
 */
export function isUnattendedForbiddenTool(wireName: string): boolean {
  return (
    UNATTENDED_FORBIDDEN_TOOLS.has(wireName) ||
    isTaskForbiddenIdentityTool(wireName) ||
    isTaskForbiddenSkillTool(wireName)
  );
}
