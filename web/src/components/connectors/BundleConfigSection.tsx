import { useState } from "react";
import { clearBundleUserConfig, type InstalledConnector } from "../../api/client";
import { BundleCredentialsModal } from "./BundleCredentialsModal";

/**
 * Stdio bundle credentials section. Renders only when the bundle's
 * manifest declares `user_config`. Reads schema + per-field populated
 * boolean from the InstalledConnector — never from a separate fetch,
 * so the parent's refresh is the only source of truth.
 *
 * Admin-only edit + clear affordances. Non-admins see the same row
 * statuses (configured / not configured) but no buttons. The Edit
 * modal opens `BundleCredentialsModal`; Clear nukes the whole
 * credential file via `clearBundleUserConfig`.
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

  // Schema declaration order is the rendering order — bundle authors
  // intentionally put required fields first; sorting alphabetically
  // would invert their authored sequence.
  const fieldKeys = Object.keys(schema);
  const anyPopulated = fieldKeys.some((k) => populated[k]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Bundle configuration
        </h2>
        {canManage && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted shrink-0"
          >
            Edit
          </button>
        )}
      </div>

      <ul className="border border-border rounded divide-y divide-border">
        {fieldKeys.map((key) => {
          const field = schema[key];
          if (!field) return null;
          const isPopulated = populated[key] === true;
          return (
            <li key={key} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{field.title ?? key}</div>
                {field.description && (
                  <div className="text-xs text-muted-foreground truncate">{field.description}</div>
                )}
              </div>
              <span
                className={`text-xs shrink-0 ${
                  isPopulated ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {isPopulated ? "✓ configured" : "Not configured"}
              </span>
            </li>
          );
        })}
      </ul>

      {canManage && anyPopulated && (
        <button
          type="button"
          onClick={onClear}
          disabled={clearing}
          className="text-xs text-muted-foreground hover:text-destructive hover:underline underline-offset-4 disabled:opacity-60"
        >
          {clearing ? "Clearing…" : "Clear configuration"}
        </button>
      )}

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
