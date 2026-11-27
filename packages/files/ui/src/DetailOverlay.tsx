import { useState } from "react";
import { fileExtension, formatSize, isImage, sourceLabel } from "./format";
import { DownloadIcon, FileTypeIcon } from "./icons";
import { Overlay } from "./Overlay";
import type { FileEntry } from "./types";
import { useFileDownload, useFileObjectUrl } from "./useFileObjectUrl";

interface Props {
  file: FileEntry;
  /** The '/'-separated path of the file's folder; "" at the top level. */
  location: string;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
  onMove: () => void;
}

/** The open file: its preview, its details, and what can be done with it. */
export function DetailOverlay({ file, location, deleting, onClose, onDelete, onMove }: Props) {
  const download = useFileDownload();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      await download(file);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Overlay label={file.filename} className="detail-panel" onClose={onClose}>
      <div className="detail-header">
        <div className="detail-title">{file.filename}</div>
        <button type="button" className="detail-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="detail-preview">
        <DetailPreview file={file} />
      </div>

      <div className="detail-fields">
        <Field
          label="Folder"
          value={location ? `Files / ${location.split("/").join(" / ")}` : "Files"}
        />
        <Field label="Type" value={file.mimeType || "Unknown"} />
        <Field label="Size" value={formatSize(file.size || 0)} />
        <Field
          label="Created"
          value={file.createdAt ? new Date(file.createdAt).toLocaleString() : "Unknown"}
        />
        {file.source && <Field label="Source" value={sourceLabel(file.source)} />}
        {file.description && <Field label="Description" value={file.description} />}
        <Field label="ID" value={file.id} mono />
        {file.tags && file.tags.length > 0 && (
          <div className="detail-field">
            <div className="detail-label">Tags</div>
            <div className="detail-tags">
              {file.tags.map((t) => (
                <span key={t} className="detail-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {downloadError && <div className="detail-error">Couldn’t download this file.</div>}

      <div className="detail-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={downloading}
          onClick={handleDownload}
        >
          <DownloadIcon size={14} />
          {downloading ? "Downloading…" : "Download"}
        </button>
        <button type="button" className="btn-ghost" onClick={onMove}>
          Move to…
        </button>
        <button type="button" className="btn-danger" disabled={deleting} onClick={onDelete}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Overlay>
  );
}

/**
 * Full-size preview. Images load through the bridge (same `files://`
 * resource path as the grid thumbnails); non-images — and images that
 * fail to load — show the type icon with the extension caption.
 */
function DetailPreview({ file }: { file: FileEntry }) {
  const image = isImage(file.mimeType);
  const { url, state } = useFileObjectUrl(file.id, file.mimeType, image);

  if (image && url !== null && state === "loaded") {
    return <img src={url} alt={file.filename} />;
  }
  if (image && state !== "error") {
    return <div className="detail-shimmer" />;
  }
  const ext = fileExtension(file.filename);
  return (
    <>
      <FileTypeIcon mimeType={file.mimeType} size={56} />
      {ext && <span className="detail-preview-ext">{ext}</span>}
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-field">
      <div className="detail-label">{label}</div>
      <div className={`detail-value${mono ? " detail-id" : ""}`}>{value}</div>
    </div>
  );
}
