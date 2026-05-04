import { formatSize, isImage, relativeTime } from "./format";
import { FileTypeIcon, FolderIcon } from "./icons";
import type { FileEntry } from "./types";

const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] as const;

interface Props {
  loading: boolean;
  files: FileEntry[];
  searchQuery: string;
  hasFilter: boolean;
  onSelect: (file: FileEntry) => void;
}

export function FileGrid({ loading, files, searchQuery, hasFilter, onSelect }: Props) {
  if (loading) {
    return (
      <div className="loading-grid">
        {SKELETON_KEYS.map((k) => (
          <div key={k} className="skel skel-card" />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <FolderIcon size={48} />
        </div>
        {searchQuery ? (
          <>
            <div className="empty-state-title">No files found</div>
            <div className="empty-state-desc">No files match “{searchQuery}”</div>
          </>
        ) : hasFilter ? (
          <>
            <div className="empty-state-title">No files match this filter</div>
            <div className="empty-state-desc">Try a different category or tag.</div>
          </>
        ) : (
          <>
            <div className="empty-state-title">No files yet</div>
            <div className="empty-state-desc">Files created in conversations will appear here.</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="file-grid">
      {files.map((f) => (
        <button type="button" key={f.id} className="file-card" onClick={() => onSelect(f)}>
          <div className="file-thumb">
            {isImage(f.mimeType) ? (
              <img src={`/v1/files/${f.id}`} alt={f.filename} loading="lazy" />
            ) : (
              <FileTypeIcon mimeType={f.mimeType} />
            )}
          </div>
          <div className="file-info">
            <div className="file-name" title={f.filename}>
              {f.filename}
            </div>
            <div className="file-meta">
              <span>{formatSize(f.size || 0)}</span>
              <span>{relativeTime(f.createdAt)}</span>
            </div>
            {f.tags && f.tags.length > 0 && (
              <div className="file-tags">
                {f.tags.slice(0, 3).map((t) => (
                  <span key={t} className="file-tag">
                    {t}
                  </span>
                ))}
                {f.tags.length > 3 && <span className="file-tag">+{f.tags.length - 3}</span>}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
