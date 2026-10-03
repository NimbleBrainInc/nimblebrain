import { useCallback, useEffect, useState } from "react";
import { callTool, readResource } from "../../../api/client";
import { Textarea } from "../../../components/ui/textarea";
import { useAutosaveForm } from "../../../hooks/useAutosaveForm";
import { AutosaveField } from "./AutosaveField";
import { InlineError } from "./InlineError";

/**
 * Character cap matches the backend's `MAX_INSTRUCTIONS_CHARS` in
 * `src/instructions/types.ts`. Both count Unicode code points, so an emoji is
 * one character — `text.length` (UTF-16 units) would count it as two.
 */
const MAX_WORKSPACE_INSTRUCTIONS = 8 * 1024;

/** The counter appears once the text reaches this share of the cap. */
const COUNTER_THRESHOLD = 0.8;

function charLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

interface InstructionsValues {
  body: string;
}

/** The refusal `write_instructions` returns is JSON `{ error }` or plain text. */
function refusalText(res: { content?: Array<{ text?: string }> }): string {
  const text = res.content?.[0]?.text ?? "The instructions were not saved.";
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

/**
 * The workspace instructions as a form that saves when the editor loses focus
 * (`useAutosaveForm`). Not on a pause in typing: the instructions reach every
 * conversation in the workspace, and a half-written one would too.
 *
 * Each save names `wsId`, so a save queued behind another still lands in the
 * workspace it was written for if the reader has moved on.
 */
export function useWorkspaceInstructions(wsId: string) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const save = useCallback(
    async (_field: "body", body: string) => {
      if (charLength(body) > MAX_WORKSPACE_INSTRUCTIONS) {
        throw new Error(
          `Instructions are limited to ${MAX_WORKSPACE_INSTRUCTIONS.toLocaleString()} characters.`,
        );
      }
      const res = await callTool(
        "instructions",
        "write_instructions",
        { body },
        { workspaceId: wsId },
      );
      if (res.isError) throw new Error(refusalText(res));
    },
    [wsId],
  );

  const form = useAutosaveForm<InstructionsValues>(
    { body: "" },
    {
      save,
      labels: { body: "Workspace instructions" },
      notices: { body: { undo: true } },
    },
  );
  const { load } = form;

  useEffect(() => {
    readResource("instructions", "instructions://workspace")
      .then((result) => load({ body: result.contents?.[0]?.text ?? "" }))
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load instructions");
      })
      .finally(() => setLoading(false));
  }, [load]);

  return { form, loading, loadError };
}

/**
 * Editor body for `instructions://workspace`, inside a `Section` provided by
 * `WorkspaceGeneralTab`. `canEdit` is the UI role gate; the backend tool
 * independently re-checks role on write.
 */
export function WorkspaceInstructions({
  wsId,
  canEdit,
  instructions,
}: {
  wsId: string;
  canEdit: boolean;
  instructions: ReturnType<typeof useWorkspaceInstructions>;
}) {
  const { form, loading, loadError } = instructions;

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const id = `workspace-instructions-${wsId}`;
  const charCount = charLength(form.values.body);
  const showCounter = charCount >= MAX_WORKSPACE_INSTRUCTIONS * COUNTER_THRESHOLD;
  const overLimit = charCount > MAX_WORKSPACE_INSTRUCTIONS;

  return (
    <div className="space-y-3">
      {loadError ? <InlineError message={loadError} /> : null}

      <AutosaveField
        id={id}
        label="Instructions"
        {...form.fieldState("body")}
        hint={
          showCounter ? (
            <span className={overLimit ? "text-destructive" : undefined}>
              {charCount.toLocaleString()} / {MAX_WORKSPACE_INSTRUCTIONS.toLocaleString()}{" "}
              characters
            </span>
          ) : canEdit ? (
            "Saves when you click away."
          ) : (
            "Only workspace admins can edit these instructions."
          )
        }
      >
        <Textarea
          id={id}
          placeholder={
            canEdit
              ? "e.g. Always cite sources for engineering claims. Prefer concise summaries."
              : "No workspace instructions set."
          }
          disabled={!canEdit || loadError !== null}
          className="min-h-32 text-sm"
          {...form.textareaProps("body")}
        />
      </AutosaveField>
    </div>
  );
}
