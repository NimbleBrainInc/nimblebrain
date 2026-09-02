import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useFlashState } from "../../hooks/useFlashState";
import {
  EmptyState,
  InlineError,
  RequireActiveWorkspace,
  Section,
  SettingsPageHeader,
} from "./components";

/**
 * Workspace webhooks — the inbound delivery URLs this workspace holds.
 *
 * The URL is shown in full, because that is what it is FOR: an address an admin
 * hands to another system. A page that hid it would leave rotation as the only
 * way to learn one, which breaks the integration you were trying to read.
 *
 * Admin-only, gated in two places that answer different questions. The nav
 * entry's `minRole` decides whether the tab is worth showing; the tool decides
 * whether the URL is returned at all. Only the second is a control — a hidden
 * tab is a hidden tab, not a permission.
 */

interface Webhook {
  connector: string;
  vendor: string;
  route: string;
  url: string;
  createdAt: string;
  rotatedAt: string | null;
  previousStillValid: boolean;
}

/** The address, with the copy affordance the workspace-id widget established. */
function WebhookUrl({ url }: { url: string }) {
  const [copied, flashCopied] = useFlashState(1500);
  return (
    <div className="flex items-center justify-between gap-2">
      {/* Always visible, so a failed clipboard write (Safari over plain HTTP,
          a sandboxed iframe, a denied permission) still leaves the URL
          selectable by hand. */}
      <code className="block text-sm font-mono truncate min-w-0">{url}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          navigator.clipboard
            .writeText(url)
            .then(flashCopied)
            .catch(() => {});
        }}
        className="h-8 w-8 p-0 shrink-0"
        aria-label={`Copy the delivery URL`}
      >
        {copied ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
}

function RotateControl({ hook, onRotated }: { hook: Webhook; onRotated: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
        Rotate
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Rotating mints a new URL and asks {hook.connector} to register it with {hook.vendor}. The
        current URL keeps working for a short grace window so deliveries already in flight are not
        lost — then it stops. Type <code className="text-2xs">{hook.vendor}</code> to confirm.
      </p>
      <div className="flex items-center gap-2">
        <Label htmlFor={`confirm-${hook.vendor}`} className="sr-only">
          Type {hook.vendor} to confirm
        </Label>
        <Input
          id={`confirm-${hook.vendor}`}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={hook.vendor}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          disabled={confirm !== hook.vendor || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const res = await callTool("hooks", "rotate_webhook", {
                connector: hook.connector,
                vendor: hook.vendor,
                confirm,
              });
              const out = parseToolResult<{ registered?: boolean; error?: string | null }>(res);
              // A mint that the connector did not register is NOT a failure to
              // report as one: the new URL works at the door, and the vendor is
              // still on the old one, which the grace window is holding open.
              if (out && out.registered === false) {
                setError(
                  `Rotated, but ${hook.connector} did not register the new URL with ` +
                    `${hook.vendor}. The previous URL still works until its grace window ` +
                    `closes — rotate again, or register the new URL manually.`,
                );
              }
              onRotated();
              setOpen(false);
              setConfirm("");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Rotation failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Rotating…" : "Rotate"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? <InlineError message={error} /> : null}
    </div>
  );
}

export function WorkspaceWebhooksTab() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await callTool("hooks", "list_webhooks", {});
      const out = parseToolResult<{ webhooks?: Webhook[] }>(res);
      setHooks(out?.webhooks ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this workspace's webhooks");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <SettingsPageHeader
        title="Webhooks"
        description="Inbound delivery URLs for connectors in this workspace. Anyone holding one can send this workspace events, so treat a URL as a credential."
      />
      <RequireActiveWorkspace>
        {error ? <InlineError message={error} /> : null}
        {hooks && hooks.length === 0 ? (
          <EmptyState message="No connector in this workspace declares an inbound stream, so there is no delivery URL to show. One is minted when a connector that receives provider events is installed." />
        ) : null}
        {(hooks ?? []).map((hook) => (
          <Section key={`${hook.connector}:${hook.vendor}`} title={hook.vendor}>
            <div className="space-y-3">
              <WebhookUrl url={hook.url} />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <dt>Connector</dt>
                <dd className="font-mono">{hook.connector}</dd>
                <dt>Delivered to</dt>
                <dd className="font-mono">{hook.route}</dd>
                <dt>Created</dt>
                <dd>{new Date(hook.createdAt).toLocaleString()}</dd>
                {hook.rotatedAt ? (
                  <>
                    <dt>Last rotated</dt>
                    <dd>{new Date(hook.rotatedAt).toLocaleString()}</dd>
                  </>
                ) : null}
              </dl>
              {hook.previousStillValid ? (
                // Worth saying plainly: mid-rotation is exactly when it is still
                // safe to defer re-registering, and the operator cannot tell from
                // the URL alone.
                <p className="text-xs text-muted-foreground">
                  The previous URL still works while its grace window is open.
                </p>
              ) : null}
              <RotateControl hook={hook} onRotated={load} />
            </div>
          </Section>
        ))}
      </RequireActiveWorkspace>
    </div>
  );
}
