import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { Button } from "../../components/ui/button";
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
  /** Null when the registration predates delivery ids; rotating mints one. */
  url: string | null;
  createdAt: string;
  rotatedAt: string | null;
  previousStillValid: boolean;
}

/**
 * The address, as a labelled field — the shape `CopyableWorkspaceId` established
 * for "a value you are here to copy".
 *
 * A registration with no id has no address, and says so instead of rendering
 * one. `buildHookUrl` on a missing id produces a URL ending in `undefined`:
 * plausible, copyable, and admitted nowhere. The door already refuses such a
 * record, so showing an address here would be the page disagreeing with the
 * door about the one fact it exists to report.
 */
function WebhookUrl({ url }: { url: string | null }) {
  const [copied, flashCopied] = useFlashState(1500);

  if (!url) {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Delivery URL</Label>
        <p className="text-sm text-muted-foreground">
          None yet — this registration predates the current addressing, so the door will not admit
          it. Rotate to mint one and hand it to the connector.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Delivery URL</Label>
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/50 px-3 py-2">
        {/* Always visible, so a failed clipboard write (Safari over plain HTTP,
            a sandboxed iframe, a denied permission) still leaves the URL
            selectable by hand. */}
        <code className="block flex-1 text-xs font-mono truncate min-w-0">{url}</code>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard
              .writeText(url)
              .then(flashCopied)
              .catch(() => {});
          }}
          className="h-7 w-7 p-0 shrink-0"
          aria-label="Copy the delivery URL"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </Button>
      </div>
    </div>
  );
}

function RotateControl({ hook, onRotated }: { hook: Webhook; onRotated: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await callTool("hooks", "rotate_webhook", {
        connector: hook.connector,
        vendor: hook.vendor,
      });
      const out = parseToolResult<{ registered?: boolean; error?: string | null }>(res);
      // A mint the connector did not register is NOT a failure to report as one:
      // the new URL works at the door, and the vendor is still on the old one,
      // which the grace window is holding open.
      if (out && out.registered === false) {
        setError(
          `Rotated, but ${hook.connector} did not register the new URL with ${hook.vendor}. ` +
            "The previous URL keeps working until its grace window closes — rotate again once " +
            "the connector is healthy, or register the new URL manually.",
        );
      }
      onRotated();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rotation failed");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
        Rotate
      </Button>
    );
  }

  // One confirming click, and no typed word. Rotating is not destructive: the
  // current URL keeps working through the grace window and the connector
  // re-registers the new one on its own, so the cost of an accidental rotation
  // is a re-registration nobody has to perform. Typed confirmation is for an
  // action you cannot take back.
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={rotate} disabled={busy}>
          {busy ? "Rotating…" : "Rotate now"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <p className="text-xs text-muted-foreground">
          Mints a new URL and asks {hook.connector} to register it with {hook.vendor}. The current
          URL keeps working for a grace window, then stops.
        </p>
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
        {(hooks ?? []).map((hook, i) => (
          <Section
            key={`${hook.connector}:${hook.vendor}`}
            title={hook.vendor}
            description={hook.connector}
            flush={i === 0}
            action={<RotateControl hook={hook} onRotated={load} />}
          >
            <div className="space-y-3">
              <WebhookUrl url={hook.url} />
              {/* `max-content` so a label hugs its value. A plain two-column grid
                  splits the container, which pushes every value to the far side
                  of the page and reads as two unrelated lists. */}
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <dt>Delivered to</dt>
                <dd className="font-mono text-foreground/80">{hook.route}</dd>
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
            </div>
          </Section>
        ))}
      </RequireActiveWorkspace>
    </div>
  );
}
