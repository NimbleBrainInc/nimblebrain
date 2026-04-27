import { FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool, readResource } from "../../../api/client";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Textarea } from "../../../components/ui/textarea";

/**
 * Byte cap matches the backend's `MAX_INSTRUCTIONS_BYTES` in
 * `src/instructions/types.ts`. Counting must be in UTF-8 bytes (via
 * `Blob`) — using `text.length` (UTF-16 code units, ≈ characters)
 * lets emoji-heavy bodies pass UI validation and 500 on save.
 *
 * Display label says "characters" because that's the user-facing
 * unit for typical Markdown text; for ASCII the byte and character
 * counts are identical, and for multibyte text the cap kicks in
 * earlier than the user might expect, but the request never fails
 * silently — the count is accurate.
 */
const MAX_WORKSPACE_INSTRUCTIONS = 8 * 1024;

function utf8ByteLength(text: string): number {
  return new Blob([text]).size;
}

/**
 * Editor for `instructions://workspace` — the active workspace's overlay.
 *
 * Used by `WorkspaceGeneralTab` (`/settings/workspace/general`).
 * Not reused on the org-admin "manage another workspace" page
 * (`/settings/org/workspaces/:slug`) — the instructions resource and
 * write tool both resolve the target workspace from the request
 * context (active workspace), so editing on that page would silently
 * mutate the wrong workspace.
 *
 * `wsId` is informational (used for the form id only — backend writes the
 * active workspace's overlay regardless, since `instructions__write_instructions`
 * resolves the workspace from the request context). `canEdit` is the role
 * gate at the UI layer; the backend tool independently re-checks role on
 * write, so this prop is convenience, not security.
 */
export function WorkspaceInstructions({ wsId, canEdit }: { wsId: string; canEdit: boolean }) {
  const [text, setText] = useState("");
  const [lastSaved, setLastSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

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
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [overLimit, text]);

  const handleReset = useCallback(() => {
    setText(lastSaved);
    setSaveError(null);
  }, [lastSaved]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">Workspace Instructions</h4>
        </div>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">Workspace Instructions</h4>
      </div>
      <p className="text-xs text-muted-foreground">
        Custom instructions injected into every conversation in this workspace. Applies on top of
        organization-wide policies and is readable by anyone in the workspace.
      </p>

      {loadError && (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      )}

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
            {charCount.toLocaleString()} / {MAX_WORKSPACE_INSTRUCTIONS.toLocaleString()} characters
          </span>
          {savedFlash && (
            <span role="status" className="text-green-600 dark:text-green-400">
              Saved
            </span>
          )}
        </div>
      </div>

      {saveError && (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      )}

      {canEdit && (
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
      )}

      {!canEdit && (
        <p className="text-xs text-muted-foreground italic">
          Only workspace admins can edit these instructions.
        </p>
      )}
    </div>
  );
}
