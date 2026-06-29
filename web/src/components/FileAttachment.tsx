import { File as FileIcon, FileText, Image } from "lucide-react";
import { useState } from "react";
import { fileUrl } from "../api/client";

export interface FileAttachmentData {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
}

interface Props {
  file: FileAttachmentData;
  /**
   * The conversation this attachment belongs to. Sent to the file endpoint so a
   * cross-workspace attachment resolves to the conversation's workspace, not the
   * focused one (which can differ on a resume).
   */
  conversationId?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getTypeIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.includes("pdf") || mimeType.includes("text") || mimeType.includes("document"))
    return FileText;
  return FileIcon;
}

export function FileAttachment({ file, conversationId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const isImage = file.mimeType.startsWith("image/");
  const isPending = file.id.startsWith("pending_");
  const Icon = getTypeIcon(file.mimeType);

  // Images with a real server-side ID get a thumbnail
  if (isImage && !isPending && !imgError) {
    return (
      <div className="inline-block">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="block cursor-pointer"
        >
          <img
            src={fileUrl(file.id, undefined, conversationId)}
            alt={file.filename}
            loading="lazy"
            onError={() => setImgError(true)}
            className={`rounded-sm border border-border transition-all duration-200 ${
              expanded ? "max-w-full" : "max-w-[240px] max-h-[180px]"
            } object-contain`}
          />
        </button>
        <span className="block text-3xs text-muted-foreground mt-1">
          {file.filename} ({formatFileSize(file.size)})
        </span>
      </div>
    );
  }

  // Non-images, pending uploads, or failed image loads → file chip
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-sm bg-muted border border-border text-sm">
      <Icon style={{ width: 16, height: 16 }} className="text-muted-foreground shrink-0" />
      <span className="truncate max-w-[200px]">{file.filename}</span>
      <span className="text-muted-foreground text-xs shrink-0">{formatFileSize(file.size)}</span>
      {file.extracted && (
        <span className="text-3xs text-success" title="Content extracted">
          extracted
        </span>
      )}
    </div>
  );
}
