import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type InstalledConnector,
  listWorkspaceSecretKeys,
  uninstallConnector,
} from "../../api/client";
import { workspaceKeysDeclaredBy } from "../../lib/secret-headers";
import { ConfirmDialog } from "../ui/confirm-dialog";

/**
 * Confirm an uninstall, and say what it takes with it.
 *
 * The connector's `secretHeaders` declaration names the workspace secrets it
 * owns, and removing the connector removes them: leaving them behind strands a
 * live outbound capability with nothing referencing it and — because the
 * rotation section renders only for an installed connector — no surface left
 * that admits it exists.
 *
 * There is no keep-them option, because there is nothing for one to preserve.
 * A connector declaring `secretHeaders` cannot be installed without supplying
 * every value first (`ConnectorBrowsePage.onInstall` routes it through the
 * collection dialog, which default-denies a blank field), so a reinstall
 * re-collects and overwrites whatever was held back. The opt-out would keep a
 * value the next install replaces — buying nothing, and leaving the orphan this
 * dialog exists to prevent.
 *
 * Keys and timestamps only. There is no value here, no masked preview of one,
 * and no read that could produce either — the key and when it was written are
 * the whole of what a confirmation needs.
 */
export function UninstallConnectorDialog({
  installed,
  open,
  onOpenChange,
  onUninstalled,
}: {
  installed: InstalledConnector;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the connector is gone. Receives a message when a key outlived it. */
  onUninstalled: (warning?: string) => void;
}) {
  const cat = installed.catalog;
  const displayName = cat?.name ?? installed.connectorName ?? installed.serverName;
  // Every key the entry names, from BOTH declaration sites — `secretHeaders`
  // and, for the built-in `credential` provider, `providerAuth.config.key`.
  // The rotation section reads only the first, which is right for a form that
  // collects values; here it would omit the one credential of a connector using
  // the second shape, and the server would delete it with nothing on screen
  // having said so.
  //
  // Gated on `provider` because that is the only auth kind either site is wired
  // on. Naming a key uninstall does not delete would make the dialog a worse
  // lie than the silence it replaces.
  const keys = useMemo(() => (cat ? workspaceKeysDeclaredBy(cat) : []), [cat]);

  const [stored, setStored] = useState<Map<string, string> | null>(null);
  const [listFailed, setListFailed] = useState(false);

  // Read on open, not on mount. Which keys are set is a fact about this moment,
  // and this is a rare action on a page that otherwise never needs it.
  const refresh = useCallback(async () => {
    if (keys.length === 0) return;
    try {
      const res = await listWorkspaceSecretKeys();
      setStored(new Map(res.keys.map((k) => [k.key, k.updatedAt])));
      setListFailed(false);
    } catch {
      // Leaving `stored` null is what keeps this from reading as an answer: an
      // empty map would claim every key is unset. The reason is not shown —
      // the dialog is about the uninstall, and deleting an absent key is a
      // no-op either way.
      setStored(null);
      setListFailed(true);
    }
  }, [keys.length]);

  useEffect(() => {
    if (!open) return;
    setStored(null);
    setListFailed(false);
    void refresh();
  }, [open, refresh]);

  // Only claimed off a list actually read. Unknown means every declared key is
  // named, unqualified, which is the honest shape of "we could not check".
  const named = stored === null ? keys : keys.filter((key) => stored.has(key));

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Uninstall ${displayName}?`}
      description="Removes it for everyone in this workspace, along with its tool permissions."
      confirmLabel="Uninstall"
      pendingLabel="Uninstalling…"
      destructive
      onConfirm={async () => {
        const res = await uninstallConnector(installed.serverName, "workspace");
        // Name the survivors. This notice replaces the Configure page, which
        // goes with the connector — it is the last surface on which a key that
        // outlived its connector can be identified at all.
        const stranded = res.failedSecretKeys ?? [];
        onUninstalled(
          res.secretDeleteError
            ? `${displayName} was uninstalled, but ${
                stranded.length > 0
                  ? `${stranded.join(", ")} ${stranded.length === 1 ? "is" : "are"} still stored`
                  : "its stored credentials could not be removed"
              }: ${res.secretDeleteError}`
            : undefined,
        );
      }}
    >
      {named.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {named.length === 1 ? "This stored credential" : "These stored credentials"} will be
            deleted:
          </p>
          <ul className="space-y-0.5">
            {named.map((key) => {
              const at = stored?.get(key);
              return (
                <li key={key} className="font-mono text-2xs">
                  {key}
                  {at && (
                    <span className="text-muted-foreground"> — set {formatWrittenAt(at)}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {listFailed && (
            <p className="text-muted-foreground">
              Couldn't check which of these are stored. Removing one that isn't set does nothing.
            </p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

/**
 * An ISO timestamp as a date. Deliberately coarser than the rotation section's
 * relative time: the question here is "is this the credential I think it is",
 * not "how stale is it". Unparseable falls back to nothing recognisable rather
 * than a wrong claim.
 */
function formatWrittenAt(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "at an unknown time";
  return new Date(ts).toLocaleDateString();
}
