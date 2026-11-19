import { Building2, User } from "lucide-react";
import type { AuthoredSkillScope } from "../../lib/plugins";
import { Badge } from "../ui/badge";

/**
 * Whose a skill is, in the words the plugin rows use: "Yours" with the person
 * glyph for the viewer's own, "Workspace" for the workspace's, "Org" for the
 * organization's.
 */
export function SkillScopeBadge({ scope }: { scope: AuthoredSkillScope }) {
  return (
    <Badge variant="outline" data-testid="skill-scope-badge" data-scope={scope}>
      {scope === "user" && <User aria-hidden="true" />}
      {scope === "org" && <Building2 aria-hidden="true" />}
      {scope === "user" ? "Yours" : scope === "org" ? "Org" : "Workspace"}
    </Badge>
  );
}
