import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type InstalledConnector,
  listWorkspaceSecretKeys,
  type WorkspaceSecretKey,
} from "../../api/client";
import { secretHeaderFieldsFrom } from "../../lib/secret-headers";
import { Button } from "../ui/button";
import { SecretHeadersModal } from "./SecretHeadersModal";

/**
 * The workspace secrets this connector sends, and when each was last written.
 *
 * Renders only for a `provider`-auth connector whose catalog entry declares
 * `secretHeaders` — the one shape whose install actually wires the header.
 * Rotation is the same dialog Browse uses before install, for the same reason:
 * replacing a value must not be a chat call either. A `set_secret` on an
 * existing key is picked up by the next request the connector makes — nothing
 * restarts, and the persisted connection config does not change.
 *
 * `list_secret_keys` reports keys and timestamps and no values, which is exactly
 * what tells this view whether a reference will resolve. There is deliberately
 * no "show current value": reading a secret back to render it is a new way out
 * of the store bought for nothing. It is also ws-admin gated, so a member sees
 * "status unknown" rather than a guess — see `refresh`.
 */
export function WorkspaceSecretsSection({
  installed,
  canManage,
}: {
  installed: InstalledConnector;
  canManage: boolean;
}) {
  const cat = installed.catalog;
  // Gated on `provider` for the same reason Browse is: only that branch of the
  // install wires a header, so on any other auth kind the declaration is inert
  // and this section would offer to rotate a value nothing sends.
  const fields = useMemo(
    () => (cat?.auth === "provider" ? secretHeaderFieldsFrom(cat.secretHeaders) : []),
    [cat?.auth, cat?.secretHeaders],
  );

  const [keys, setKeys] = useState<WorkspaceSecretKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const refresh = useCallback(async () => {
    if (fields.length === 0) return;
    try {
      const res = await listWorkspaceSecretKeys();
      setKeys(res.keys);
      setError(null);
    } catch (err) {
      // `list_secret_keys` is ws-admin gated, so a member is refused BY DESIGN
      // and lands here on every render. Leaving `keys` null is what keeps that
      // from reading as an answer: an empty list would render every key "not
      // set" and raise the cannot-reach-upstream banner on a working connector,
      // which is a false claim to the one reader least able to check it.
      setKeys(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fields.length]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (fields.length === 0) return null;

  const writtenAt = (key: string): string | undefined =>
    keys?.find((k) => k.key === key)?.updatedAt;
  // Only ever claimed off a list we actually read. `keys === null` covers both
  // "still loading" and "the read was refused or failed" — neither is evidence
  // that a key is unset, and this drives the banner and the button's label.
  const anyMissing = keys !== null && fields.some((f) => writtenAt(f.key) === undefined);

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Workspace credentials
      </h2>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground space-y-0.5">
          {fields.map((f) => {
            const at = writtenAt(f.key);
            return (
              <div key={f.header}>
                <span className="text-foreground font-medium">{f.label}</span>
                {" — "}
                {keys === null
                  ? error
                    ? "status unknown"
                    : "checking…"
                  : at
                    ? `set ${formatRelativeTime(at)}`
                    : "not set"}
                {", sent as "}
                <span className="font-mono">{f.header}</span>
              </div>
            );
          })}
          {anyMissing && (
            <div className="text-amber-600">
              This connector cannot reach its upstream until every value is set.
            </div>
          )}
          {error &&
            (canManage ? (
              // An admin's read genuinely failed — they can act on the reason,
              // so show it rather than swallowing it behind the role message.
              <div className="text-destructive">Couldn't read which values are set: {error}</div>
            ) : (
              <div>Only a workspace admin can view or change these values.</div>
            ))}
        </div>
        {canManage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setEditing(true)}
          >
            {anyMissing ? "Set credentials" : "Replace credentials"}
          </Button>
        )}
      </div>
      {editing && (
        <SecretHeadersModal
          connectorName={cat?.name ?? installed.serverName}
          fields={fields}
          open={editing}
          mode={anyMissing ? "collect" : "rotate"}
          onClose={() => setEditing(false)}
          onStored={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * Render an ISO timestamp as "5m ago", "2d ago", etc. Falls back to a date
 * string past 30 days, and to nothing recognisable rather than a wrong claim
 * when the timestamp will not parse.
 */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "at an unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
