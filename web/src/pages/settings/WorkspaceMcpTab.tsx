import { Check, Copy } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useFlashState } from "../../hooks/useFlashState";
import { RequireActiveWorkspace, Section, SettingsFormPage } from "./components";

/**
 * Workspace "MCP" tab — the URL an external MCP client connects to.
 *
 * Route: /w/:slug/settings/mcp (the workspace is the URL slug).
 * Permission: any workspace member; connecting is gated per request by
 * membership, so the URL is not a secret.
 *
 * The URL comes from the server (`mcpUrl` on the bootstrap's workspace entry),
 * never from `window.location`: it is the canonical resource URL tokens are
 * bound to, on the configured public origin, which is not always the host this
 * page was loaded from.
 *
 * The workspace ID lives here too, as a quiet copy link under the URL: the URL
 * embeds it, and the people who need the bare ID are the ones wiring a client.
 */
export function WorkspaceMcpTab() {
  return (
    <RequireActiveWorkspace>
      <Inner />
    </RequireActiveWorkspace>
  );
}

function Inner() {
  const { activeWorkspace } = useWorkspaceContext();
  // RequireActiveWorkspace guarantees activeWorkspace is non-null here.
  const ws = activeWorkspace!;

  return (
    <SettingsFormPage
      title="MCP"
      description="Connect an MCP client, such as Claude or Cursor, to this workspace."
    >
      <Section title="Server URL" flush>
        <McpUrl url={ws.mcpUrl ?? null} />
        <CopyWorkspaceIdLink workspaceId={ws.id} />
      </Section>
    </SettingsFormPage>
  );
}

function McpUrl({ url }: { url: string | null }) {
  const [copied, flashCopied] = useFlashState(1500);

  if (!url) {
    return (
      <p className="text-sm text-muted-foreground">
        The server did not report this workspace's MCP URL, so it cannot be shown here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/50 px-3 py-2">
          {/* Always visible, so a failed clipboard write (Safari over plain
              HTTP, a sandboxed iframe, a denied permission) still leaves the
              URL selectable by hand. */}
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
            aria-label="Copy the MCP URL"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Add it as a custom connector in your MCP client; it signs you in, and reaches this workspace
        only.
      </p>
    </div>
  );
}

function CopyWorkspaceIdLink({ workspaceId }: { workspaceId: string }) {
  const [copied, flashCopied] = useFlashState(1500);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(workspaceId)
          .then(flashCopied)
          .catch(() => {});
      }}
      title={workspaceId}
      data-testid="mcp-copy-workspace-id"
      className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy workspace ID"}
    </button>
  );
}
