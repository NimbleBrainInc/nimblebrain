import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type { SkillDetail } from "../_generated/platform-schemas/skills";
import { callTool, listPlugins } from "../api/client";
import {
  AudienceOption,
  type InstallAudience,
} from "../components/connectors/InstallAudienceDialog";
import { PanelHeading } from "../components/connectors/personal-connector";
import { useNotice } from "../components/notices";
import { SECTION_ROW } from "../components/plugins/list-parts";
import { SkillHereSwitch } from "../components/plugins/SkillHereSwitch";
import { SkillScopeBadge } from "../components/plugins/SkillScopeBadge";
import { Button } from "../components/ui/button";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useCanWriteActiveWorkspace } from "../hooks/useScopedRole";
import {
  type AuthoredSkill,
  callSkillsTool,
  isAuthoredScope,
  listAuthoredSkills,
  writeResult,
} from "../lib/authored-skills";
import { type AuthoredSkillScope, skillPath, skillsPath } from "../lib/plugins";
import { skillLoadsText } from "../lib/skill-display";
import { linkSafety, rehypePlugins } from "../lib/streamdown-config";
import { parseToolResponse } from "../lib/tool-response";
import { cn } from "../lib/utils";
import { toWsId } from "../lib/workspace-slug";
import { InlineError } from "./settings/components";
import {
  type CreateDraft,
  CreateSkillView,
  createSkillArgs,
  EditSkillForm,
  LoadingVerdict,
  Toggle,
} from "./settings/SkillEditor";
import type { SkillUpdateArgs } from "./settings/skill-edit-patch";

/**
 * One skill someone wrote, at `/w/:slug/skills/:scope/:name`, opened from
 * Skills. Who may change it follows the server's
 * write rules: a workspace skill needs workspace write, the viewer's own skill
 * is theirs, and an org skill is read here and changed in org settings.
 *
 * One column, because this renders in the main area beside the docked chat
 * (`web/DESIGN.md`).
 */
export function SkillPage() {
  const {
    slug = "",
    scope = "",
    name = "",
  } = useParams<{
    slug: string;
    scope: string;
    name: string;
  }>();
  return (
    <SkillsColumn slug={slug}>
      {/* Keyed by the route: a param-only change reuses the element, and one
          skill's state and open form must not carry over to the next. */}
      {isAuthoredScope(scope) ? (
        <SkillDetailView key={`${slug}/${scope}/${name}`} slug={slug} scope={scope} name={name} />
      ) : (
        <NotHere />
      )}
    </SkillsColumn>
  );
}

/**
 * The Skills column, with its link back to Skills unless the page brings its
 * own (the new skill form's header has a back button that cancels it).
 */
function SkillsColumn({
  slug,
  backLink = true,
  children,
}: {
  slug: string;
  backLink?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-(--page-gutter) py-6 space-y-8">
        {/* A block, not inline: the column's spacing is a margin on each child. */}
        {backLink && (
          <Link
            to={skillsPath(slug)}
            className="block w-fit py-1 text-xs text-muted-foreground hover:underline"
          >
            ← Skills
          </Link>
        )}
        {children}
      </div>
    </div>
  );
}

function NotHere() {
  return <p className="text-sm">This skill is not in this workspace.</p>;
}

/** What a locked toggle tells a screen reader about who can change the skill. */
function lockedToggleNote(scope: AuthoredSkillScope): string {
  return scope === "workspace" ? "managed by workspace admins" : "managed elsewhere";
}

function SkillDetailView({
  slug,
  scope,
  name,
}: {
  slug: string;
  scope: AuthoredSkillScope;
  name: string;
}) {
  const wsId = toWsId(slug);
  const navigate = useNavigate();
  const canWriteWorkspace = useCanWriteActiveWorkspace();
  const editable = scope === "user" || (scope === "workspace" && canWriteWorkspace);
  const [skill, setSkill] = useState<AuthoredSkill | null | undefined>(undefined);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  // Names the plugins a tool pattern reaches; until it answers, "a matching tool".
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const findSkill = useCallback(async () => {
    const skills = await listAuthoredSkills(wsId);
    return skills.find((s) => s.scope === scope && s.name === name) ?? null;
  }, [wsId, scope, name]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await findSkill();
      if (cancelled) return;
      setSkill(found);
      if (!found) return;
      // Read where it was listed: the workspace's listings carry every tier.
      const res = await callTool("skills", "read", { id: found.id }, { workspaceId: wsId });
      if (!cancelled) setDetail(parseToolResponse<SkillDetail>(res));
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    listPlugins(wsId).then(
      (next) => !cancelled && setPlugins(next.plugins),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [findSkill, wsId]);

  // After a write the row's facts (how it loads, on or off) are re-read. The
  // open form seeded once and is never overwritten by the re-read.
  const refresh = useCallback(async () => {
    const found = await findSkill();
    if (found) setSkill(found);
  }, [findSkill]);

  const onSave = useCallback(
    async (_id: string, args: SkillUpdateArgs) => {
      try {
        writeResult(await callSkillsTool(scope, wsId, "update", args));
      } finally {
        await refresh().catch(() => {});
      }
    },
    [scope, wsId, refresh],
  );

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const toggle = (current: AuthoredSkill) =>
    run(async () => {
      const status = current.status === "active" ? "disabled" : "active";
      writeResult(await callSkillsTool(scope, wsId, "set_status", { id: current.id, status }));
      await refresh();
    });

  const remove = (current: AuthoredSkill) => {
    if (!window.confirm("Delete this skill? It will be snapshotted to _versions/ first.")) return;
    void run(async () => {
      writeResult(await callSkillsTool(scope, wsId, "delete", { id: current.id }));
      navigate(skillsPath(slug));
    });
  };

  if (error && skill === undefined) {
    return <InlineError message={`Unable to load this skill: ${error}. Reload to retry.`} />;
  }
  if (skill === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (skill === null) return <NotHere />;

  // The full answer, the default included; the raw patterns are in the
  // loading details below.
  const loads = skillLoadsText(skill, plugins, { includeDefault: true });
  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-xl font-semibold tracking-tight">
              {skill.name}
            </h1>
            <SkillScopeBadge scope={skill.scope} />
          </div>
          {skill.description && (
            <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
          )}
          {loads && (
            <p className="mt-0.5 text-xs text-muted-foreground" data-testid="skill-mechanism">
              {loads}
            </p>
          )}
        </div>
        <Toggle
          on={skill.status === "active"}
          onChange={() => void toggle(skill)}
          disabled={!editable || pending}
          disabledNote={editable ? undefined : lockedToggleNote(scope)}
          label={skill.name}
        />
      </header>

      {skill.scope === "user" && (
        <HereSection
          skill={skill}
          workspaceId={wsId}
          onChange={(onHere) => setSkill((prev) => (prev ? { ...prev, onHere } : prev))}
        />
      )}

      {error && <InlineError message={error} />}

      {!detail ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : editable ? (
        <>
          <EditSkillForm id={detail.id} skill={detail} onSave={onSave} />
          <div className="border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => remove(skill)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete skill
            </Button>
          </div>
        </>
      ) : (
        <ReadOnlySkill detail={detail} scope={scope} />
      )}
    </div>
  );
}

/**
 * Whether the viewer's own skill applies in this workspace. A disabled skill
 * applies nowhere, so here is moot: it says Disabled where the switch would be.
 */
function HereSection({
  skill,
  workspaceId,
  onChange,
}: {
  skill: AuthoredSkill;
  workspaceId: string;
  onChange: (onHere: boolean) => void;
}) {
  const disabled = skill.status !== "active";
  return (
    <section className={cn(SECTION_ROW, "border-y border-border/60 py-4")} data-testid="skill-here">
      <PanelHeading
        title="In this workspace"
        hint={
          disabled
            ? "Turn the skill on first. Then it applies in every workspace unless you turn it off here."
            : "Your skills apply in every workspace unless you turn one off here."
        }
      />
      {disabled ? (
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="skill-state">
          Disabled
        </span>
      ) : (
        <SkillHereSwitch
          skill={skill}
          workspaceId={workspaceId}
          className="shrink-0"
          onChange={onChange}
        />
      )}
    </section>
  );
}

/** A skill the viewer cannot change here: its body, how it loads, and who can. */
function ReadOnlySkill({ detail, scope }: { detail: SkillDetail; scope: AuthoredSkillScope }) {
  const meta = detail.metadata;
  return (
    <div className="space-y-4" data-testid="skill-read-only">
      <p className="text-sm text-muted-foreground">
        {scope === "org"
          ? "Set for the whole organization. Org admins change it in org settings."
          : "Workspace admins can change it."}
      </p>
      <LoadingVerdict
        strategy={meta.loadingStrategy === "dynamic" ? "dynamic" : "always"}
        toolAffinity={meta.toolAffinity ?? []}
        triggers={meta.triggers ?? []}
        body={detail.content}
      />
      <div className="max-w-prose text-sm text-foreground/80">
        <Streamdown
          className="streamdown-container"
          linkSafety={linkSafety}
          rehypePlugins={rehypePlugins}
        >
          {detail.content}
        </Streamdown>
      </div>
    </div>
  );
}

/**
 * A new skill, at `/w/:slug/skills/new`, opened from Skills' New skill. It asks
 * whom the skill is for in the install dialog's words: "Just me" writes it to
 * the viewer's own skills, which follow them into every workspace; "Everyone in
 * <workspace>" writes it to the workspace, offered only to a member who may
 * write the workspace.
 */
export function NewSkillPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return (
    <SkillsColumn slug={slug} backLink={false}>
      <NewSkill key={slug} slug={slug} />
    </SkillsColumn>
  );
}

function NewSkill({ slug }: { slug: string }) {
  const wsId = toWsId(slug);
  const navigate = useNavigate();
  const notify = useNotice();
  const { workspaces } = useWorkspaceContext();
  const workspaceName = workspaces.find((w) => w.id === wsId)?.name ?? "this workspace";
  const canWriteWorkspace = useCanWriteActiveWorkspace();
  const [audience, setAudience] = useState<InstallAudience>("personal");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (draft: CreateDraft) => {
    const scope: AuthoredSkillScope =
      audience === "workspace" && canWriteWorkspace ? "workspace" : "user";
    setPending(true);
    setError(null);
    try {
      const out = writeResult(
        await callSkillsTool(scope, wsId, "create", createSkillArgs(scope, draft)),
      );
      if (out.frontmatterApplied?.length) {
        notify({
          level: "info",
          title: "Applied the pasted frontmatter",
          description: `It set ${out.frontmatterApplied.join(", ")}. The block itself was not stored as body text.`,
        });
      }
      navigate(skillPath(slug, scope, out.name ?? draft.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <CreateSkillView
      pending={pending}
      error={error}
      onCancel={() => navigate(skillsPath(slug))}
      onCreate={(draft) => void create(draft)}
      audience={
        <fieldset className="space-y-2">
          <legend className="mb-2 block text-sm font-medium">Who is it for?</legend>
          <div role="radiogroup" aria-label="Who is it for" className="space-y-2 text-xs">
            <AudienceOption
              name="skill-audience"
              value="personal"
              selected={audience === "personal"}
              onSelect={setAudience}
              label="Just me"
              hint="Only your agent reads it, here and in every workspace you use."
            />
            {canWriteWorkspace ? (
              <AudienceOption
                name="skill-audience"
                value="workspace"
                selected={audience === "workspace"}
                onSelect={setAudience}
                label={`Everyone in ${workspaceName}`}
                hint="The agent reads it for everyone in this workspace."
              />
            ) : (
              <p className="text-muted-foreground">
                A workspace admin can write a skill for everyone in {workspaceName}.
              </p>
            )}
          </div>
        </fieldset>
      }
    />
  );
}
