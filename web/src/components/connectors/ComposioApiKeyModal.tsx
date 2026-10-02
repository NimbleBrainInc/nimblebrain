import { useMemo } from "react";
import { type ComposioField, connectComposioApiKey } from "../../api/client";
import { type CredentialField, CredentialFieldsModal } from "./CredentialFieldsModal";

/**
 * Field-collection modal for a non-redirect (API-key) Composio connector.
 * Instead of an OAuth round-trip, the user pastes the connector's declared
 * `fields` (e.g. a PostHog personal API key + region), which are handed to
 * Composio at connect time and never persisted by the platform. Used for both
 * first connect and reconnect/rotation (the rotation case is ws_admin gated
 * server-side; the error surfaces inline).
 *
 * Form shape is driven entirely by `fields` so any API-key toolkit reuses it —
 * the component knows nothing PostHog-specific. The form itself is
 * {@link CredentialFieldsModal}, shared with the workspace-secret path; all this
 * adds is Composio's vocabulary (`title` → `label`) and where the values go.
 */
export function ComposioApiKeyModal({
  catalogId,
  connectorName,
  fields,
  open,
  onClose,
  onConnected,
}: {
  catalogId: string;
  connectorName: string;
  fields: ComposioField[];
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const modalFields = useMemo<CredentialField[]>(
    () =>
      fields.map((f) => ({
        key: f.key,
        label: f.title,
        ...(f.description ? { description: f.description } : {}),
        ...(f.sensitive ? { sensitive: true } : {}),
        ...(f.required !== undefined ? { required: f.required } : {}),
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      })),
    [fields],
  );

  return (
    <CredentialFieldsModal
      titleId="composio-apikey"
      title={`Connect ${connectorName}`}
      description="Enter your credentials below. They're sent to the connector provider and never stored by the platform."
      fields={modalFields}
      submitLabel="Connect"
      busyLabel="Connecting…"
      open={open}
      onClose={onClose}
      onSubmit={async (values) => {
        await connectComposioApiKey(catalogId, values);
        onConnected();
      }}
    />
  );
}
