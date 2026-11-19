import { useEffect, useState } from "react";
import { setSkillOnHere } from "../../api/client";
import type { AuthoredSkill } from "../../lib/authored-skills";
import { cn } from "../../lib/utils";
import { useNotice } from "../notices";
import { Switch } from "../ui/switch";

/**
 * Whether one of the viewer's own skills applies in this workspace (ADR-0072).
 * Their skills apply in every workspace unless turned off in one, so this is
 * offered only on a `user`-scope skill; a workspace or org skill is changed by
 * whoever owns it.
 *
 * The switch flips at once and saves in the background; a refused save puts it
 * back and says why in a notice, since the switch alone cannot. It takes no
 * second flip while a save is in flight.
 *
 * It carries no visible text: the row or section around it says "Off here"
 * when it is off, and its accessible name says what it switches.
 */
export function SkillHereSwitch({
  skill,
  workspaceId,
  onChange,
  className,
}: {
  skill: AuthoredSkill;
  /** The workspace the switch applies to: the page's, not whichever is active when it saves. */
  workspaceId: string;
  /**
   * The state it shows, so the row around it can say so too: called at the
   * flip, then with the saved state, or the restored one if the save fails.
   */
  onChange?: (on: boolean) => void;
  className?: string;
}) {
  const notify = useNotice();
  const listed = skill.onHere !== false;
  const [on, setOn] = useState(listed);
  const [pending, setPending] = useState(false);

  // A re-read of the listing is the truth once no save of this switch is in flight.
  useEffect(() => {
    if (!pending) setOn(listed);
  }, [listed, pending]);

  if (skill.scope !== "user") return null;

  const flip = async (next: boolean) => {
    if (pending) return;
    setOn(next);
    onChange?.(next);
    setPending(true);
    try {
      const saved = await setSkillOnHere(workspaceId, skill.id, next);
      setOn(saved.onHere);
      onChange?.(saved.onHere);
    } catch (err) {
      setOn(!next);
      onChange?.(!next);
      notify({
        level: "error",
        title: `Couldn't turn ${skill.name} ${next ? "on" : "off"} here`,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <span className={cn("flex items-center", className)} data-testid="skill-on-here" data-on={on}>
      <Switch
        checked={on}
        onCheckedChange={(next) => void flip(next)}
        disabled={pending}
        aria-label={`On here: ${skill.name}`}
      />
    </span>
  );
}
