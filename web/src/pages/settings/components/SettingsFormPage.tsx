import type { ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { InlineError } from "./InlineError";
import { SettingsPageHeader, type SettingsPageHeaderProps } from "./SettingsPageHeader";

/**
 * Layout template for settings pages whose primary content is a *form*
 * (Profile, Model, WorkspaceGeneral). Owns:
 *
 *   - page header (title, description, optional back-nav, optional icon)
 *   - body spacing between sections
 *   - the save bar (Save / Reset / inline feedback) — gated on `dirty`
 *     and `saving`, with success/error messaging baked in
 *
 * The page does NOT wrap content in an outer Card. Cards-as-page-chrome
 * was one of the inconsistencies we set out to fix; sections separate
 * themselves with spacing and a top border (see `Section`).
 *
 * Pages that don't have a save bar can omit the `save` prop entirely: a
 * read-only form, or one whose fields save as they change (`useAutosaveForm`),
 * where each field shows its own status and a save raises a notice.
 */
export interface SettingsFormPageProps extends SettingsPageHeaderProps {
  /**
   * Save bar config. Omit for read-only pages. The bar renders inline
   * below `children`, not sticky — most settings forms aren't long enough
   * to need sticky, and inline avoids viewport-occlusion issues.
   */
  save?: {
    onSave: () => void | Promise<void>;
    saving?: boolean;
    /**
     * Tristate: `true` enables Save, `false` disables it (clean state),
     * `undefined` means the page doesn't track dirty — Save stays enabled
     * regardless. Profile / Model rely on the undefined branch because
     * users expect Save to be available without first re-typing a value.
     */
    dirty?: boolean;
    /**
     * Override the default disable rule (`saving || dirty === false`).
     * Use when the page has additional gating (over-byte-limit, missing
     * required field, etc).
     */
    disabled?: boolean;
    label?: string;
    /** When provided, shows a Reset button next to Save that calls this. */
    onReset?: () => void;
  };
  /** Persistent banner above the body (e.g. "Loading failed, retry?"). */
  loadError?: string | null;
  /** Inline status / error rendered between content and save bar. */
  feedback?: { type: "success" | "error"; message: string } | null;
  /** When true, skips the body and renders a centered loading message. */
  loading?: boolean;
  loadingMessage?: string;
  children: ReactNode;
}

export function SettingsFormPage({
  title,
  description,
  icon,
  action,
  back,
  save,
  loadError,
  feedback,
  loading,
  loadingMessage = "Loading...",
  children,
}: SettingsFormPageProps) {
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={title}
        description={description}
        icon={icon}
        action={action}
        back={back}
      />

      {loadError ? <InlineError message={loadError} /> : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{loadingMessage}</p>
      ) : (
        <>
          <div className="space-y-6">{children}</div>
          {feedback ? <FeedbackMessage feedback={feedback} /> : null}
          {save ? <SaveBar save={save} /> : null}
        </>
      )}
    </div>
  );
}

/** Inline success/error status rendered between the form body and the save bar. */
function FeedbackMessage({
  feedback,
}: {
  feedback: NonNullable<SettingsFormPageProps["feedback"]>;
}) {
  const isSuccess = feedback.type === "success";
  return (
    <p
      className={cn("text-sm", isSuccess ? "text-success dark:text-green-400" : "text-destructive")}
      role={isSuccess ? "status" : "alert"}
    >
      {feedback.message}
    </p>
  );
}

/** Save bar: Save button plus an optional Reset, with gating derived from `save`. */
function SaveBar({ save }: { save: NonNullable<SettingsFormPageProps["save"]> }) {
  const cleanOrSaving = save.saving || save.dirty === false;
  return (
    <div className="flex gap-2 pt-2">
      <Button
        onClick={() => void save.onSave()}
        disabled={save.disabled ?? cleanOrSaving}
        aria-busy={save.saving}
      >
        {save.saving ? "Saving..." : (save.label ?? "Save")}
      </Button>
      {save.onReset ? (
        <Button variant="outline" onClick={save.onReset} disabled={cleanOrSaving}>
          Reset
        </Button>
      ) : null}
    </div>
  );
}
