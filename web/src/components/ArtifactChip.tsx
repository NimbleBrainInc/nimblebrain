import { ChevronRight, FileText } from "lucide-react";
import { useArtifactPanel } from "../context/ArtifactPanelContext";

export interface ArtifactChipProps {
  /** Server/app that owns the resource — forwarded to the document panel. */
  appName: string;
  /** Resource URI from the resource_link block (e.g. `files://<id>`). */
  uri: string;
  /** Display title from the resource_link `name`. */
  name?: string;
  /** Declared MIME type (e.g. `text/markdown`). */
  mimeType?: string;
  /** Optional description surfaced in the panel header. */
  description?: string;
}

/** Human-readable kind label from a MIME type. */
function kindLabel(mimeType: string | undefined): string {
  if (!mimeType) return "Document";
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime === "text/markdown" || mime === "text/x-markdown") return "Report";
  if (mime === "text/plain") return "Text document";
  return "Document";
}

function titleFromUri(uri: string): string {
  const tail = uri.split("/").pop();
  return tail && tail.length > 0 ? tail : uri;
}

/**
 * Compact, persistent reference to a document artifact in the chat stream.
 *
 * Replaces the cramped inline raw-markdown box for `resource_link` document
 * results: a small card (icon, title, kind subtitle, Open affordance) that
 * opens the full report in the global document panel. It carries only the
 * resource ref — no fetched content — so it survives conversation reload as
 * long as `tc.resourceLinks` is persisted.
 */
export function ArtifactChip({ appName, uri, name, mimeType, description }: ArtifactChipProps) {
  const { openArtifact } = useArtifactPanel();
  const title = name ?? titleFromUri(uri);

  return (
    <button
      type="button"
      onClick={() => openArtifact({ appName, uri, name, mimeType, description })}
      className="group w-full my-2 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/40 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open ${title}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileText className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{kindLabel(mimeType)}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        Open
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
