import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IdentityStatus {
  core: { name: string; body: string };
  override: { body: string } | null;
  effective: string;
}

export function getIdentityStatus(
  skillsDir: string,
  coreSkillsDir: string,
  workspaceIdentity?: string,
): IdentityStatus {
  // Find soul.md — check core skills dir first, then user skills dir
  let coreBody = "";
  const coreName = "soul";

  const candidatePaths = [
    join(coreSkillsDir, "soul.md"),
    join(skillsDir, "soul.md"),
    join(skillsDir, "context", "soul.md"),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      try {
        coreBody = readFileSync(candidate, "utf-8").trim();
        if (coreBody) break;
      } catch {
        // Unreadable — try next
      }
    }
  }

  // Workspace identity override
  const override = workspaceIdentity ? { body: workspaceIdentity } : null;

  const effective = override ? `${coreBody}\n\n---\n\n${override.body}` : coreBody;

  return {
    core: { name: coreName, body: coreBody },
    override,
    effective,
  };
}
