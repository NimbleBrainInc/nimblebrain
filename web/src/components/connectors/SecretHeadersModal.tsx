import { useMemo } from "react";
import { setWorkspaceSecret } from "../../api/client";
import type { SecretHeaderField } from "../../lib/secret-headers";
import { type CredentialField, CredentialFieldsModal } from "./CredentialFieldsModal";

/**
 * Collect the workspace secrets a connector's `secretHeaders` declares, and
 * write each to the workspace credential store.
 *
 * The connector names a key; this asks for the value. Nothing about the key or
 * the header it binds to is sent — both are operator-authored and the server
 * re-reads them from the trusted catalog entry at install, which is what keeps
 * a self-installable platform connector from being pointed somewhere else. The
 * only thing that travels is a value against a key the server already knows.
 *
 * Every field is written before `onStored` resolves, so a caller can install
 * immediately after and the eager start finds its credential. A partial write
 * (the second `set_secret` failing after the first succeeded) surfaces the
 * error and leaves the dialog open: the keys already stored are correct, and
 * re-submitting overwrites them with the same values.
 */
export function SecretHeadersModal({
  connectorName,
  fields,
  open,
  onClose,
  onStored,
  mode = "collect",
}: {
  connectorName: string;
  fields: SecretHeaderField[];
  open: boolean;
  onClose: () => void;
  onStored: () => void | Promise<void>;
  /** `collect` is the pre-install ask; `rotate` is replacing values already set. */
  mode?: "collect" | "rotate";
}) {
  const modalFields = useMemo<CredentialField[]>(
    () =>
      fields.map((f) => ({
        key: f.key,
        label: f.label,
        // Fall back to naming the header when the entry declared no help. It is
        // the one true thing available about where the value goes, and a user
        // looking at two similar inputs needs to tell them apart.
        description: f.help ?? `Sent as ${f.header}.`,
        // Always masked. Every value here is a credential by construction — the
        // declaration exists to keep them out of config, so none belongs on
        // screen in plaintext either.
        sensitive: true,
      })),
    [fields],
  );

  return (
    <CredentialFieldsModal
      titleId="connector-secrets"
      title={
        mode === "rotate" ? `Replace ${connectorName} credentials` : `Connect ${connectorName}`
      }
      description={
        mode === "rotate"
          ? "Enter the new values. They replace what this workspace has stored; the next request the connector makes uses them, with no restart."
          : `${connectorName} needs credentials only this workspace holds. They're stored in the workspace credential store and sent on each request — never shown again, and never part of a conversation.`
      }
      fields={modalFields}
      submitLabel={mode === "rotate" ? "Replace" : "Save and install"}
      busyLabel="Saving…"
      open={open}
      onClose={onClose}
      onSubmit={async (values) => {
        for (const field of fields) {
          const value = values[field.key];
          if (value === undefined) continue;
          await setWorkspaceSecret(field.key, value);
        }
        await onStored();
      }}
    />
  );
}
