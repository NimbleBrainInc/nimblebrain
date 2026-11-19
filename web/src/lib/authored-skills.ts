import type { ToolInput } from "../_generated/platform-schemas/catalog";
import type {
  SkillSummary,
  SkillsListOutput,
  SkillsWriteOutput,
} from "../_generated/platform-schemas/skills";
import { callTool, callToolWithoutWorkspace } from "../api/client";
import type { ToolCallResponse } from "../types";
import type { AuthoredSkillScope } from "./plugins";
import { parseToolResponse } from "./tool-response";

/** A skill someone wrote, in one of the tiers a person authors in (ADR-0034). */
export type AuthoredSkill = SkillSummary & { scope: AuthoredSkillScope };

const SCOPE_ORDER: Record<AuthoredSkillScope, number> = { workspace: 0, user: 1, org: 2 };
const AUTHORED_SCOPES: readonly AuthoredSkillScope[] = ["workspace", "user", "org"];

export function isAuthoredScope(scope: string): scope is AuthoredSkillScope {
  return scope === "workspace" || scope === "user" || scope === "org";
}

/**
 * The skills people wrote, out of a `skills__list` answer: the workspace's,
 * the viewer's own, and the org's, by tier and then by name. A `provided` skill
 * ships with the platform or a server and is not written here, and a skill that
 * names a connector came with that connector's plugin and is shown on its page.
 */
export function authoredSkills(skills: readonly SkillSummary[]): AuthoredSkill[] {
  return skills
    .filter((s): s is AuthoredSkill => isAuthoredScope(s.scope) && !s.source.connector)
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/**
 * Every authored skill that reaches this workspace for the viewer, one listing
 * per tier. An unfiltered listing merges tiers by name the way a conversation
 * loads them, so a personal skill would hide a same-named workspace skill;
 * a tier's own listing keeps it.
 */
export async function listAuthoredSkills(wsId: string): Promise<AuthoredSkill[]> {
  const tiers = await Promise.all(
    AUTHORED_SCOPES.map(async (scope) => {
      const res = await callTool("skills", "list", { scope }, { workspaceId: wsId });
      return parseToolResponse<SkillsListOutput>(res).skills;
    }),
  );
  return authoredSkills(tiers.flat());
}

/**
 * Call a `skills__*` tool for a skill in `scope`. A workspace skill is written
 * in the workspace the page names. The viewer's own and the org's are in no
 * workspace and are written with none (ADR-0043), as their settings pages do.
 */
export function callSkillsTool<T extends string>(
  scope: AuthoredSkillScope,
  wsId: string,
  tool: T,
  args: ToolInput<"skills", T>,
): Promise<ToolCallResponse> {
  return scope === "workspace"
    ? callTool("skills", tool, args, { workspaceId: wsId })
    : callToolWithoutWorkspace("skills", tool, args);
}

/** The result of a skills write, or the refusal it came back with as an error. */
export function writeResult(res: ToolCallResponse): Partial<SkillsWriteOutput> {
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
  return parseToolResponse<Partial<SkillsWriteOutput>>(res);
}
