import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface Props {
  files: File[];
  onRemove: (index: number) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A key per attached `File` object, so removing one chip leaves the others (and
 * their previews) mounted. Two picks of the same file are two `File` objects,
 * so a duplicate still gets a key of its own.
 */
const fileKeys = new WeakMap<File, number>();
let nextFileKey = 0;
function keyOf(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = nextFileKey++;
    fileKeys.set(file, key);
  }
  return key;
}

function Thumbnail({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!src) return null;
  return <img src={src} alt={file.name} className="w-8 h-8 rounded object-cover shrink-0" />;
}

export function FileAttachmentChips({ files, onRemove }: Props) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {files.map((file, idx) => (
        <div
          key={keyOf(file)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-sm bg-muted text-xs text-foreground border border-border"
        >
          {file.type.startsWith("image/") && <Thumbnail file={file} />}
          <span className="truncate max-w-[120px]">{file.name}</span>
          <span className="text-muted-foreground shrink-0">{formatFileSize(file.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="p-0.5 rounded hover:bg-border transition-colors text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${file.name}`}
          >
            <X style={{ width: 12, height: 12 }} />
          </button>
        </div>
      ))}
    </div>
  );
}
