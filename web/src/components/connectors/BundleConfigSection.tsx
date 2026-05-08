import { useState } from "react";
import { clearBundleUserConfig, type InstalledConnector } from "../../api/client";
import { BundleCredentialsModal } from "./BundleCredentialsModal";

/**
 * Bundle credentials — compact summary form. Mirrors
 * `OperatorOAuthSection`'s pattern: show a one-line "Configured" /
 * "X of N configured" indicator plus an Edit button (admin-gated)
 * that opens the schema-driven modal. The actual fields, hints, and
 * sensitive inputs all live in `BundleCredentialsModal` — never on
 * the page surface.
 *
 * Renders only when at least one field is populated. The unpopulated
 * case is the hero's job — its `needs_setup` CTA opens the same
 * modal, so a fresh stdio install funnels there. Once the user has
 * saved at least one field, this section appears as the "edit later"
 * affordance.
 */
export function BundleConfigSection({
  installed,
  canManage,
  onChanged,
}: {
  installed: InstalledConnector;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schema = installed.userConfig?.schema;
  const populated = installed.userConfig?.populated ?? {};

  if (!schema || Object.keys(schema).length === 0) return null;

  // Renders only when something is configured. The hero handles the
  // empty case; doubling it here adds noise to a settings surface
  // that's already crowded for stdio bundles with multiple sections.
  const fieldKeys = Object.keys(schema);
  const populatedKeys = fieldKeys.filter((k) => populated[k]);
  if (populatedKeys.length === 0) return null;

  const onClear = async () => {
    if (
      !confirm(
        `Clear all configured credentials for "${installed.catalog?.name ?? installed.serverName}"? This removes every saved field.`,
      )
    ) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      await clearBundleUserConfig(installed.serverName);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  // Summary copy matches the granularity of what's actually saved.
  // "Configured" reads cleanest when every required field is set;
  // "X of N configured" surfaces when a partial save left a gap
  // (e.g. user filled in api_key but skipped optional workspace_id).
  const summary =
    populatedKeys.length === fieldKeys.length
      ? "Configured"
      : `${populatedKeys.length} of ${fieldKeys.length} configured`;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Bundle configuration
      </h2>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-muted-foreground">{summary}</div>
        {canManage && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClear}
              disabled={clearing}
              className="text-xs text-muted-foreground hover:text-destructive hover:underline underline-offset-4 disabled:opacity-60"
            >
              {clearing ? "Clearing…" : "Clear configuration"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs px-3 py-1.5 rounded border border-border bg-background hover:bg-muted"
            >
              Edit
            </button>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {editing && (
        <BundleCredentialsModal
          installed={installed}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
