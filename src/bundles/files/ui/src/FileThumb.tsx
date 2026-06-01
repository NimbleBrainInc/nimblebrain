import { useEffect, useRef, useState } from "react";
import { fileExtension, isImage } from "./format";
import { FileTypeIcon } from "./icons";
import type { FileEntry } from "./types";
import { useFileObjectUrl } from "./useFileObjectUrl";

/**
 * Grid thumbnail. Images are fetched through the bridge and shown
 * cover-cropped; everything else shows a type icon plus the uppercase
 * file extension so a PDF, an XML, and a spreadsheet are distinguishable
 * at a glance. Image bytes load lazily once the card scrolls within 200px
 * of the viewport, so a large grid doesn't fan out N reads on mount.
 */
export function FileThumb({ file }: { file: FileEntry }) {
  const image = isImage(file.mimeType);
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    if (!image || near) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [image, near]);

  const { url, state } = useFileObjectUrl(file.id, file.mimeType, image && near);

  const showImage = image && url !== null && state === "loaded";
  // Fall back to the icon for non-images and for images whose read failed.
  const showIcon = !image || state === "error";
  const ext = fileExtension(file.filename);

  return (
    <div className="file-thumb" ref={ref}>
      {showImage ? (
        <img src={url} alt={file.filename} />
      ) : showIcon ? (
        <>
          <FileTypeIcon mimeType={file.mimeType} />
          {ext && <span className="file-thumb-ext">{ext}</span>}
        </>
      ) : (
        // Image bytes are in flight (or queued behind the viewport gate).
        <div className="file-thumb-shimmer" />
      )}
    </div>
  );
}
