import { Lock } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ToolInput } from "../../_generated/platform-schemas/catalog";
import type { SkillDetail as ReadSkill } from "../../_generated/platform-schemas/skills";
// The runtime's own predicate and token math, mirrored verbatim by
// `bun run codegen`. The editor answers "will this load, and what does it
// cost?" live, before a save exists to ask the server about — and a
// hand-written second copy of either would drift with nothing to catch it.
import { resolveLoadingMechanism } from "../../_generated/skill-loading";
import { approxTokens } from "../../_generated/skill-tokens";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import { formatTokenCount, skillLoadingSentence } from "../../lib/skill-display";
import { cn } from "../../lib/utils";
import { AutosaveField, SettingsPageHeader } from "./components";
import {
  type LoadingStrategy,
  looksLikeFrontmatter,
  MAX_PRIORITY,
  MIN_PRIORITY,
  parseLines,
  type SkillEditField,
  type SkillEditValues,
  type SkillUpdateArgs,
  skillEditPatch,
} from "./skill-edit-patch";

/**
 * The skill editor: the create form, the edit form whose fields save as they
 * change, the loading verdict both show, and the on/off toggle. Every surface
 * that writes a skill renders these (the settings and profile Skills tabs, and
 * a skill's page under Plugins), so a skill is authored the same way wherever
 * it is opened.
 */

// ── Toggle ───────────────────────────────────────────────────────────────

export function Toggle({
  on,
  onChange,
  disabled,
  disabledNote,
  label,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  disabledNote?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      // A sibling of the row's expander, not a descendant — a click here
      // reaches no other control, so it needs no `stopPropagation`. The
      // `disabled` attribute is what suppresses the locked-tier click.
      onClick={onChange}
      disabled={disabled}
      aria-label={
        disabled
          ? `${label} — ${on ? "on" : "off"}, ${disabledNote ?? "managed elsewhere"}`
          : `${on ? "Turn off" : "Turn on"} ${label}`
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 px-2 py-1 rounded-sm text-xs font-medium select-none",
        disabled ? "text-muted-foreground cursor-default" : "text-foreground hover:bg-muted",
      )}
    >
      {disabled && <Lock className="h-3 w-3" aria-hidden />}
      <span className={cn("w-2 h-2 rounded-full", on ? "bg-success" : "bg-muted-foreground/60")} />
      {on ? "On" : "Off"}
    </button>
  );
}

// ── Create and edit views ─────────────────────────────────────────────────

type CreateInput = ToolInput<"skills", "create">;

export type { CreateInput };

/**
 * Slugify a user-typed name into the on-disk identifier shape the server
 * accepts (`^[a-zA-Z0-9_-]+$`). Lowercases, replaces runs of disallowed
 * characters with a single `-`, strips leading/trailing dashes.
 *
 *   "Test 123"          → "test-123"
 *   "Voice / Tone"      → "voice-tone"
 *   "  Already-Good_1"  → "already-good_1"
 */
function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** The name input of the create form, with the slug it will be saved as. */
function RuleNameField({
  name,
  slug,
  showSlugHint,
  nameRef,
  onChange,
}: {
  name: string;
  slug: string;
  showSlugHint: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor="rule-name">
        Name it
      </label>
      <Input
        id="rule-name"
        ref={nameRef}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Voice rules"
      />
      {showSlugHint && (
        <p className="text-xs text-muted-foreground">
          Saved as <span className="font-mono">{slug}</span>
        </p>
      )}
    </div>
  );
}

// ── The manifest a skill is being authored with ──────────────────────────

/** What the create form hands back on Create. */
export interface CreateDraft {
  name: string;
  description: string;
  body: string;
  priority: number;
  loadingStrategy: LoadingStrategy;
  toolAffinity: string[];
  triggers: string[];
  /** Store a leading `---` block as body text instead of reading it as frontmatter. */
  keepFrontmatterAsText: boolean;
}

/** `skills__create`'s arguments for a draft, written to `scope`. */
export function createSkillArgs(
  scope: "org" | "workspace" | "user",
  draft: CreateDraft,
): CreateInput {
  // The escape hatch, opt-in: a body whose leading `---` is genuinely
  // prose. Default is `apply`, so the ordinary paste just works.
  const frontmatter = draft.keepFrontmatterAsText ? "ignore" : undefined;
  return {
    scope,
    manifest: {
      name: draft.name,
      // The human title, which is also the row label. The on-disk
      // schema requires it non-empty; a pasted document that states a
      // real description overrides it server-side.
      description: draft.description,
      loadingStrategy: draft.loadingStrategy,
      priority: Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, draft.priority)),
      toolAffinity: draft.toolAffinity,
      triggers: draft.triggers,
    },
    body: draft.body,
    ...(frontmatter ? { frontmatter } : {}),
  };
}

/**
 * What will happen to this skill, stated while it is still being written.
 *
 * A skill's whole purpose is to load, so the editor says when this one will —
 * every turn, with a tool, on a phrase, or only when the agent asks — while the
 * condition can still be changed. The mechanism and the token cost are both
 * derived through the runtime's own code, so the sentence here and the row's
 * after a save are the same verdict.
 *
 * It describes one state, never a mix: the create form's draft, or an open
 * skill as saved. `footnote` says what the state leaves out.
 */
export function LoadingVerdict({
  strategy,
  toolAffinity,
  triggers,
  body,
  footnote,
}: {
  strategy: LoadingStrategy;
  toolAffinity: string[];
  triggers: string[];
  body: string;
  footnote?: string;
}) {
  const mechanism = resolveLoadingMechanism({
    loadingStrategy: strategy,
    toolAffinity,
    triggers,
  });
  const sentence = skillLoadingSentence(mechanism, { toolAffinity, triggers });
  const tokens = approxTokens(body);
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3.5 py-3 text-sm">
      <p className="font-medium">
        {sentence.text}
        {sentence.mono && (
          <>
            {" "}
            <span className="font-mono font-normal">{sentence.mono}</span>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {/* An always-on skill is paid on every turn, so its cost is stated
         * here. The estimate is the same one `skills__list` reports. */}
        {strategy === "always"
          ? `≈${formatTokenCount(tokens)} tokens in every conversation`
          : `≈${formatTokenCount(tokens)} tokens when it loads`}
        {footnote && ` · ${footnote}`}
      </p>
    </div>
  );
}

/**
 * The `---` block sitting at the top of the body, and what will become of it.
 *
 * Shown before the save rather than reported after it. On create the block
 * configures the new skill. On an existing skill the fields own those values,
 * so the block is never applied: the body's save is held until it is removed or
 * kept as text.
 */
function FrontmatterNotice({
  existing,
  keepAsText,
  onKeepAsTextChange,
}: {
  existing: boolean;
  keepAsText: boolean;
  onKeepAsTextChange: (value: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 px-3.5 py-3 space-y-2">
      {existing ? (
        <p className="text-sm">
          This starts with a <span className="font-mono">---</span> block. On an existing skill the
          fields below configure it, so a header here is not applied. Remove it, or keep it as text.
        </p>
      ) : (
        <p className="text-sm">
          This starts with a <span className="font-mono">---</span> block. If it's SKILL.md
          frontmatter, its fields configure the skill on save and the block isn't stored as text.
        </p>
      )}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={keepAsText}
          onChange={(e) => onKeepAsTextChange(e.target.checked)}
        />
        Keep it as body text instead
      </label>
    </div>
  );
}

/** A newline-separated list field — tool patterns, trigger phrases. */
function ListField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The two loading strategies as a radio pair. A choice is a complete edit. */
function StrategyRadios({
  id,
  value,
  onChange,
  invalid,
}: {
  id?: string;
  value: LoadingStrategy;
  onChange: (value: LoadingStrategy) => void;
  invalid?: boolean;
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label="When it loads"
      aria-invalid={invalid || undefined}
      className="flex flex-col gap-1 pt-1"
    >
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="loading-strategy"
          value="always"
          checked={value === "always"}
          onChange={() => onChange("always")}
        />
        Always — in context every conversation
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="loading-strategy"
          value="dynamic"
          checked={value === "dynamic"}
          onChange={() => onChange("dynamic")}
        />
        On demand — only when something below matches
      </label>
    </div>
  );
}

const TOOL_AFFINITY_HINT =
  "One glob per line, e.g. files__*. Loads whenever a matching tool is active.";
const TRIGGERS_HINT = "One phrase per line. Loads whenever the phrase appears in a message.";
const PRIORITY_HINT = `${MIN_PRIORITY}–${MAX_PRIORITY}, lower = read first (default 50)`;

/** The collapsible "Advanced" disclosure the manifest fields sit behind. */
function AdvancedDisclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-2"
      >
        <span className={cn("inline-block transition-transform", open && "rotate-90")}>▸</span>
        Advanced
      </button>
      {open && <div className="mt-4 pl-5 space-y-4 border-l border-border">{children}</div>}
    </div>
  );
}

/**
 * The create form's manifest fields, behind the prose.
 *
 * A `dynamic` skill with neither triggers nor tool-affinity is catalog-only: it
 * loads when the agent asks for it, which a thin description makes unlikely.
 * Offering the strategy is safe because `LoadingVerdict` names that outcome the
 * moment the form reaches it.
 */
function CreateAdvancedSection({
  open,
  priority,
  strategy,
  toolAffinity,
  triggers,
  onToggle,
  onPriorityChange,
  onStrategyChange,
  onToolAffinityChange,
  onTriggersChange,
}: {
  open: boolean;
  priority: number;
  strategy: LoadingStrategy;
  toolAffinity: string;
  triggers: string;
  onToggle: () => void;
  onPriorityChange: (value: number) => void;
  onStrategyChange: (value: LoadingStrategy) => void;
  onToolAffinityChange: (value: string) => void;
  onTriggersChange: (value: string) => void;
}) {
  return (
    <AdvancedDisclosure open={open} onToggle={onToggle}>
      <fieldset className="space-y-1">
        <legend className="block text-sm font-medium">When it loads</legend>
        <StrategyRadios value={strategy} onChange={onStrategyChange} />
      </fieldset>

      {/* Shown only for `dynamic`: with `always` these fields still store,
       * but nothing reads them, and a control that does nothing where it
       * sits is the kind of quiet lie this editor avoids. */}
      {strategy === "dynamic" && (
        <>
          <ListField
            id="tool-affinity"
            label="Tool patterns"
            hint={TOOL_AFFINITY_HINT}
            value={toolAffinity}
            placeholder="files__*"
            onChange={onToolAffinityChange}
          />
          <ListField
            id="triggers"
            label="Trigger phrases"
            hint={TRIGGERS_HINT}
            value={triggers}
            placeholder="deploy to staging"
            onChange={onTriggersChange}
          />
        </>
      )}

      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="priority">
          Priority
        </label>
        <div className="flex items-baseline gap-3">
          <input
            id="priority"
            type="number"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            value={priority}
            onChange={(e) => onPriorityChange(parseInt(e.target.value, 10) || 50)}
            className="text-sm bg-background border-b border-border pb-1 w-20 outline-none focus:border-foreground"
          />
          <span className="text-xs text-muted-foreground">{PRIORITY_HINT}</span>
        </div>
      </div>
    </AdvancedDisclosure>
  );
}

/** The body textarea's shared attributes. */
const BODY_PLACEHOLDER = "Match my writing voice. Avoid em-dashes.";
const BODY_HINT = "Plain English works. Use line breaks for separate ideas.";

/**
 * A new skill. Nothing exists to save into until Create, so this form keeps an
 * explicit action and sends every field at once.
 */
export function CreateSkillView({
  pending,
  error,
  onCancel,
  onCreate,
  backLabel = "Back to skills",
  audience,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (draft: CreateDraft) => void;
  backLabel?: string;
  /** Whom the skill is for, asked above its name when the surface offers a choice. */
  audience?: ReactNode;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [priority, setPriority] = useState<number>(50);
  // A new skill defaults to always-on — the editor's stated purpose is durable
  // prose the agent reads every turn — and the lede below says so rather than
  // leaving it to be discovered after the save.
  const [strategy, setStrategy] = useState<LoadingStrategy>("always");
  const [toolAffinity, setToolAffinity] = useState("");
  const [triggers, setTriggers] = useState("");
  const [keepFrontmatterAsText, setKeepFrontmatterAsText] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // The user types anything they want ("Test 123") and we slugify before
  // it reaches the server (which enforces `^[a-zA-Z0-9_-]+$` because the
  // value becomes a filename). Show the slugified form as a hint when it
  // differs from the typed value so the on-disk identity is honest.
  const slug = slugifyName(name);
  const showSlugHint = slug.length > 0 && slug !== name.trim();

  const affinityList = parseLines(toolAffinity);
  const triggerList = parseLines(triggers);
  const frontmatterPending = looksLikeFrontmatter(body) && !keepFrontmatterAsText;

  const valid = slug.length > 0 && body.trim().length > 0;

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="New skill"
        // `onBack` (not `back`) because the editor is component state on
        // SkillsBrowser, not a routed sub-page — the URL stays on
        // .../skills while editing. A router Link would navigate UP the
        // tree (out of skills) and silently drop the form state.
        onBack={{ onClick: onCancel, label: backLabel }}
      />

      {error && (
        <Card>
          <CardContent className="py-3 px-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          New skills are always on — the agent reads them in every conversation. Change that under{" "}
          <strong>Advanced</strong>, or paste a whole <span className="font-mono">SKILL.md</span>{" "}
          and its frontmatter will set it.
        </p>

        {audience}

        <RuleNameField
          name={name}
          slug={slug}
          showSlugHint={showSlugHint}
          nameRef={nameRef}
          onChange={setName}
        />

        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="rule-body">
            What should the agent do?
          </label>
          <Textarea
            id="rule-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder={BODY_PLACEHOLDER}
          />
          <p className="text-xs text-muted-foreground">{BODY_HINT}</p>
        </div>

        {looksLikeFrontmatter(body) && (
          <FrontmatterNotice
            existing={false}
            keepAsText={keepFrontmatterAsText}
            onKeepAsTextChange={setKeepFrontmatterAsText}
          />
        )}

        <LoadingVerdict
          strategy={strategy}
          toolAffinity={affinityList}
          triggers={triggerList}
          body={body}
          footnote={frontmatterPending ? "the pasted frontmatter may change this" : undefined}
        />

        <CreateAdvancedSection
          open={advancedOpen}
          priority={priority}
          strategy={strategy}
          toolAffinity={toolAffinity}
          triggers={triggers}
          onToggle={() => setAdvancedOpen((v) => !v)}
          onPriorityChange={setPriority}
          onStrategyChange={setStrategy}
          onToolAffinityChange={setToolAffinity}
          onTriggersChange={setTriggers}
        />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-6">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() =>
            valid &&
            onCreate({
              name: slug,
              // The typed title is the human label → on-disk `description`
              // (required non-empty). `name` is its slug (the filename).
              description: name.trim(),
              body: body.trim(),
              priority,
              loadingStrategy: strategy,
              toolAffinity: affinityList,
              triggers: triggerList,
              keepFrontmatterAsText,
            })
          }
          disabled={!valid || pending}
        >
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}

// ── Editing a skill that exists ──────────────────────────────────────────

const EDIT_LABELS: Record<SkillEditField, string> = {
  body: "Skill body",
  loadingStrategy: "When it loads",
  priority: "Priority",
  toolAffinity: "Tool patterns",
  triggers: "Trigger phrases",
};

/**
 * Every field changes how the skill loads or what it says, in every
 * conversation its scope reaches, the moment it saves, so each save raises a
 * notice with Undo.
 */
const EDIT_NOTICES = Object.fromEntries(
  Object.keys(EDIT_LABELS).map((field) => [field, { undo: true }]),
) as Record<SkillEditField, { undo: true }>;

/** The fields `LoadingVerdict` reads. */
const VERDICT_FIELDS: SkillEditField[] = ["body", "loadingStrategy", "toolAffinity", "triggers"];

/** An existing skill's stored values, as the edit form's field values. */
function toEditValues(skill: ReadSkill): SkillEditValues {
  return {
    body: skill.content,
    loadingStrategy: skill.metadata.loadingStrategy === "dynamic" ? "dynamic" : "always",
    priority: String(skill.metadata.priority ?? 50),
    toolAffinity: (skill.metadata.toolAffinity ?? []).join("\n"),
    triggers: (skill.metadata.triggers ?? []).join("\n"),
  };
}

/**
 * An existing skill: the read it opens from, then a form whose fields save as
 * they change. The read seeds the form once; later re-reads (after each save)
 * refresh the list behind it, never the fields being edited.
 */
export function EditSkillView({
  id,
  detail,
  onSave,
  onBack,
}: {
  id: string;
  detail: ReadSkill | null;
  onSave: (id: string, args: SkillUpdateArgs) => Promise<void>;
  onBack: () => void;
}) {
  const [seed, setSeed] = useState<ReadSkill | null>(detail);
  if (!seed && detail) setSeed(detail);
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={seed ? "Edit this skill" : "Loading…"}
        // `onBack`, not a router link: the editor is component state on
        // SkillsBrowser and the URL stays on .../skills.
        onBack={{ onClick: onBack, label: "Back to skills" }}
      />
      {seed && <EditSkillForm id={id} skill={seed} onSave={onSave} />}
    </div>
  );
}

export function EditSkillForm({
  id,
  skill,
  onSave,
}: {
  id: string;
  skill: ReadSkill;
  onSave: (id: string, args: SkillUpdateArgs) => Promise<void>;
}) {
  const initial = useMemo(() => toEditValues(skill), [skill]);
  // A stored body that opens with `---` was kept as text on purpose (the
  // server strips a header it applies), so it starts kept.
  const [keepAsText, setKeepAsText] = useState(() => looksLikeFrontmatter(skill.content));
  const keepAsTextRef = useRef(keepAsText);
  keepAsTextRef.current = keepAsText;
  // What the file holds, field by field, for the loading verdict. The form's
  // drafts can run ahead of it, or fail to reach it.
  const [saved, setSaved] = useState<SkillEditValues>(initial);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const save = useCallback(
    async <K extends SkillEditField>(field: K, value: SkillEditValues[K]) => {
      await onSave(
        id,
        skillEditPatch(id, field, value, { keepHeaderAsText: keepAsTextRef.current }),
      );
    },
    [id, onSave],
  );
  const onSaved = useCallback(
    <K extends SkillEditField>(field: K, value: SkillEditValues[K]) =>
      setSaved((prev) => ({ ...prev, [field]: value })),
    [],
  );
  const form = useAutosaveForm(initial, {
    save,
    onSaved,
    labels: EDIT_LABELS,
    notices: EDIT_NOTICES,
  });
  const { values, revert, commit } = form;

  // Hidden list fields under `always`. One holding an edit not yet saved, or a
  // failed one, would leave a change nobody can see to retry or revert, so it
  // goes back to its saved value (the same rule the Model tab applies).
  const listsShown = values.loadingStrategy === "dynamic";
  const affinityStatus = form.fieldState("toolAffinity").status;
  const triggersStatus = form.fieldState("triggers").status;
  useEffect(() => {
    if (listsShown) return;
    if (affinityStatus === "error" || affinityStatus === "dirty") revert("toolAffinity");
    if (triggersStatus === "error" || triggersStatus === "dirty") revert("triggers");
  }, [listsShown, affinityStatus, triggersStatus, revert]);

  // The verdict describes the skill as saved, so it never mixes saved fields
  // with drafts that may still fail. It names what it leaves out instead.
  const pendingVerdictFields = VERDICT_FIELDS.filter(
    (f) => form.fieldState(f).status !== "clean" && form.fieldState(f).status !== "saved",
  );
  const footnote =
    pendingVerdictFields.length > 0
      ? `as saved; not yet: ${pendingVerdictFields.map((f) => EDIT_LABELS[f].toLowerCase()).join(", ")}`
      : undefined;

  const bodyHasHeader = looksLikeFrontmatter(values.body);
  const onKeepAsTextChange = (keep: boolean) => {
    keepAsTextRef.current = keep;
    setKeepAsText(keep);
    // Keeping the header as text is what the held body save was waiting on.
    if (keep && form.fieldState("body").status === "error") commit("body");
  };

  const listField = (field: "toolAffinity" | "triggers", hint: string, placeholder: string) => (
    <AutosaveField
      id={field === "toolAffinity" ? "tool-affinity" : "triggers"}
      label={EDIT_LABELS[field]}
      hint={hint}
      {...form.fieldState(field)}
    >
      <Textarea
        id={field === "toolAffinity" ? "tool-affinity" : "triggers"}
        rows={3}
        placeholder={placeholder}
        className="font-mono text-xs"
        {...form.textareaProps(field)}
      />
    </AutosaveField>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="rule-name">
          Name
        </label>
        <Input id="rule-name" value={skill.metadata.name} disabled className="font-mono" />
        <p className="text-xs text-muted-foreground">
          Names are immutable — they're the filename on disk. Each field below saves when you leave
          it.
        </p>
      </div>

      <AutosaveField
        id="rule-body"
        label="What should the agent do?"
        hint={BODY_HINT}
        {...form.fieldState("body")}
      >
        <Textarea
          id="rule-body"
          rows={8}
          placeholder={BODY_PLACEHOLDER}
          {...form.textareaProps("body")}
        />
      </AutosaveField>

      {bodyHasHeader && (
        <FrontmatterNotice
          existing
          keepAsText={keepAsText}
          onKeepAsTextChange={onKeepAsTextChange}
        />
      )}

      <LoadingVerdict
        strategy={saved.loadingStrategy}
        toolAffinity={parseLines(saved.toolAffinity)}
        triggers={parseLines(saved.triggers)}
        body={saved.body}
        footnote={footnote}
      />

      <AdvancedDisclosure open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
        <AutosaveField
          id="loading-strategy"
          label={EDIT_LABELS.loadingStrategy}
          {...form.fieldState("loadingStrategy")}
        >
          <StrategyRadios
            id="loading-strategy"
            value={values.loadingStrategy}
            onChange={(v) => commit("loadingStrategy", v)}
            invalid={form.fieldState("loadingStrategy").status === "error"}
          />
        </AutosaveField>

        {/* Shown only for `dynamic`, as on create: under `always` nothing
         * reads them. */}
        {listsShown && listField("toolAffinity", TOOL_AFFINITY_HINT, "files__*")}
        {listsShown && listField("triggers", TRIGGERS_HINT, "deploy to staging")}

        <AutosaveField
          id="priority"
          label={EDIT_LABELS.priority}
          hint={PRIORITY_HINT}
          {...form.fieldState("priority")}
        >
          <Input
            id="priority"
            type="number"
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            className="w-24"
            {...form.inputProps("priority")}
          />
        </AutosaveField>
      </AdvancedDisclosure>
    </div>
  );
}
