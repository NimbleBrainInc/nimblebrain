import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type AuthoredSkill, listAuthoredSkills } from "../../lib/authored-skills";
import { newSkillPath, skillPath } from "../../lib/plugins";
import { skillMechanismLabel } from "../../lib/skill-display";
import { cn } from "../../lib/utils";
import { SkillScopeBadge } from "./SkillScopeBadge";

/**
 * The Installed tab's Skills group: the skills written for this workspace, the
 * viewer's own, and the org's, each linking to its page. A skill that came with
 * a plugin is on that plugin's page, so this group lists none of them.
 */
export function SkillsGroup({ wsId, slug }: { wsId: string; slug: string }) {
  const [skills, setSkills] = useState<AuthoredSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAuthoredSkills(wsId).then(
      (next) => {
        if (!cancelled) setSkills(next);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  return (
    <section className="space-y-2" data-testid="plugins-skills">
      <h2 className="text-sm font-medium text-muted-foreground">Skills</h2>
      {error ? (
        <p className="text-sm text-destructive">Unable to load skills: {error}</p>
      ) : skills === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="border-t border-border pt-2.5 text-sm text-muted-foreground">
          No skills written here yet.{" "}
          <Link
            to={newSkillPath(slug)}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Write a skill
          </Link>
        </p>
      ) : (
        <div className="border-t border-border">
          {skills.map((skill) => (
            <SkillRow key={skill.id} skill={skill} to={skillPath(slug, skill.scope, skill.name)} />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Skills that come with a plugin are on that plugin's page.
      </p>
    </section>
  );
}

/** One skill: its name, what it is for, whose it is, and how it loads. */
function SkillRow({ skill, to }: { skill: AuthoredSkill; to: string }) {
  const mechanism = skillMechanismLabel(skill);
  const off = skill.status !== "active";
  const facts = [skill.description?.trim(), mechanism?.text].filter(Boolean).join(" · ");
  return (
    <div
      className="flex items-center gap-3 border-b border-border py-2.5"
      data-testid="skill-row"
      data-skill-scope={skill.scope}
      data-skill-name={skill.name}
    >
      <Link
        to={to}
        className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded px-2 py-0.5 transition-colors hover:bg-muted/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-sm font-medium", off && "text-muted-foreground")}>
              {skill.name}
            </span>
            <SkillScopeBadge scope={skill.scope} />
          </div>
          {facts && (
            <p className="truncate text-xs text-muted-foreground" data-testid="skill-facts">
              {facts}
              {mechanism?.mono && <span className="font-mono"> {mechanism.mono}</span>}
            </p>
          )}
        </div>
        {off && <span className="shrink-0 text-xs text-muted-foreground">Off</span>}
      </Link>
    </div>
  );
}
