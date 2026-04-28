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
 *   - column width (`max-w-2xl` — narrower than list pages because forms
 *     read better at this width and the inputs don't benefit from wider
 *     space)
 *   - body spacing between sections
 *   - the save bar (Save / Reset / inline feedback) — gated on `dirty`
 *     and `saving`, with success/error messaging baked in
 *
 * The page does NOT wrap content in an outer Card. Cards-as-page-chrome
 * was one of the inconsistencies we set out to fix; sections separate
 * themselves with spacing and a top border (see `Section`).
 *
 * Pages that don't have a save bar (e.g. read-only forms) can omit the
 * `save` prop entirely.
 */
export interface SettingsFormPageProps extends Omit<SettingsPageHeaderProps, "action"> {
  /**
   * Save bar config. Omit for read-only pages. The bar renders inline
   * below `children`, not sticky — most settings forms aren't long enough
   * to need sticky, and inline avoids viewport-occlusion issues.
   */
  save?: {
    onSave: () => void | Promise<void>;
    saving?: boolean;
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
    /** Visual variant: "warm" for human-initiated, default otherwise. */
    variant?: "default" | "warm";
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
  back,
  save,
  loadError,
  feedback,
  loading,
  loadingMessage = "Loading...",
  children,
}: SettingsFormPageProps) {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <SettingsPageHeader title={title} description={description} back={back} />

      {loadError ? <InlineError message={loadError} /> : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">{loadingMessage}</p>
      ) : (
        <>
          <div className="space-y-6">{children}</div>

          {feedback ? (
            <p
              className={cn(
                "text-sm",
                feedback.type === "success"
                  ? "text-success dark:text-green-400"
                  : "text-destructive",
              )}
              role={feedback.type === "error" ? "alert" : "status"}
            >
              {feedback.message}
            </p>
          ) : null}

          {save ? (
            <div className="flex gap-2 pt-2">
              <Button
                variant={save.variant ?? "default"}
                onClick={() => void save.onSave()}
                disabled={save.disabled ?? (save.saving || save.dirty === false)}
                aria-busy={save.saving}
              >
                {save.saving ? "Saving..." : (save.label ?? "Save")}
              </Button>
              {save.onReset ? (
                <Button
                  variant="outline"
                  onClick={save.onReset}
                  disabled={save.saving || save.dirty === false}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
