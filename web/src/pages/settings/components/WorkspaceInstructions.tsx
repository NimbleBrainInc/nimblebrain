import { useCallback, useEffect, useState } from "react";
import { callTool, readResource } from "../../../api/client";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Textarea } from "../../../components/ui/textarea";
import { useFlashState } from "../../../hooks/useFlashState";
import { InlineError } from "./InlineError";

/**
 * Byte cap matches the backend's `MAX_INSTRUCTIONS_BYTES` in
 * `src/instructions/types.ts`. Counting must be in UTF-8 bytes (via
 * `Blob`) — using `text.length` (UTF-16 code units, ≈ characters)
 * lets emoji-heavy bodies pass UI validation and 500 on save. The
 * counter label is "bytes" to match what's actually being measured;
 * for ASCII text bytes ≡ characters, but emoji-heavy bodies will
 * exceed `text.length` here and that's the correct behavior.
 */
const MAX_WORKSPACE_INSTRUCTIONS = 8 * 1024;

function utf8ByteLength(text: string): number {
  return new Blob([text]).size;
}

/**
 * Editor body for `instructions://workspace` — used inside a `Section`
 * provided by `WorkspaceGeneralTab`. The Section owns the title; this
 * component renders only the field, helper copy, counter, and Save/Reset
 * buttons.
 *
 * `wsId` is informational (form id only — the backend writes to whatever
 * workspace the request resolves against). `canEdit` is the UI role gate;
 * the backend tool independently re-checks role on write.
 */
export function WorkspaceInstructions({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const [text, setText] = useState("");
  const [lastSaved, setLastSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, flashSaved] = useFlashState(1500);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const result = await readResource("instructions", "instructions://workspace");
      const body = result.contents?.[0]?.text ?? "";
      setText(body);
      setLastSaved(body);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load instructions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = text !== lastSaved;
  const charCount = utf8ByteLength(text);
  const overLimit = charCount > MAX_WORKSPACE_INSTRUCTIONS;

  const handleSave = useCallback(async () => {
    if (overLimit) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await callTool("instructions", "write_instructions", {
        scope: "workspace",
        text,
      });
      if (res.isError) {
        const errText = res.content?.[0]?.text ?? "Save failed";
        const parsed = (() => {
          try {
            return JSON.parse(errText) as { error?: string };
          } catch {
            return { error: errText };
          }
        })();
        throw new Error(parsed.error ?? "Save failed");
      }
      setLastSaved(text);
      flashSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [overLimit, text, flashSaved]);

  const handleReset = useCallback(() => {
    setText(lastSaved);
    setSaveError(null);
  }, [lastSaved]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-3">
      {loadError ? <InlineError message={loadError} /> : null}

      <div className="space-y-2">
        <Label htmlFor={`workspace-instructions-${wsId}`} className="sr-only">
          Workspace instructions
        </Label>
        <Textarea
          id={`workspace-instructions-${wsId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            canEdit
              ? "e.g. Always cite sources for engineering claims. Prefer concise summaries."
              : "No workspace instructions set."
          }
          disabled={!canEdit}
          aria-invalid={overLimit}
          className="min-h-32 font-mono text-sm"
        />
        <div className="flex items-center justify-between text-xs">
          <span className={overLimit ? "text-destructive" : "text-muted-foreground"}>
            {charCount.toLocaleString()} / {MAX_WORKSPACE_INSTRUCTIONS.toLocaleString()} bytes
          </span>
          {savedFlash ? (
            <span role="status" className="text-success dark:text-green-400">
              Saved
            </span>
          ) : null}
        </div>
      </div>

      {saveError ? <InlineError message={saveError} /> : null}

      {canEdit ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || overLimit || !dirty}
            aria-busy={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleReset} disabled={saving || !dirty}>
            Reset
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          Only workspace admins can edit these instructions.
        </p>
      )}
    </div>
  );
}
