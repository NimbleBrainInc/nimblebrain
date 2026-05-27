// Lucide-style stroke icons inlined to avoid an icon library dependency.
// All 24x24 viewBox; size via the parent element's font-size or width/height.
//
// Icons are purely decorative — every consumer pairs them with a text label
// (filename, button text, or tooltip), so each <svg> sets `aria-hidden`
// directly so Biome's `noSvgWithoutTitle` lint can see it. (Spreading the
// attribute through a const object hides it from the rule's static check.)

const STROKE_PROPS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

interface IconProps {
  size?: number;
}

export function FileIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <path d="M15 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7Z" />
      <path d="M14 2v4a2 2 0 002 2h4" />
    </svg>
  );
}

export function ImageIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 00-2.828 0L6 21" />
    </svg>
  );
}

export function FileTextIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <path d="M15 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7Z" />
      <path d="M14 2v4a2 2 0 002 2h4" />
      <line x1="8" x2="16" y1="13" y2="13" />
      <line x1="8" x2="14" y1="17" y2="17" />
    </svg>
  );
}

export function SheetIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <line x1="3" x2="21" y1="9" y2="9" />
      <line x1="3" x2="21" y1="15" y2="15" />
      <line x1="9" x2="9" y1="3" y2="21" />
      <line x1="15" x2="15" y1="3" y2="21" />
    </svg>
  );
}

export function CodeIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function TypeIcon({ size = 40 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" x2="15" y1="20" y2="20" />
      <line x1="12" x2="12" y1="4" y2="20" />
    </svg>
  );
}

export function FolderIcon({ size = 48 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE_PROPS}
    >
      <path d="M20 20a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2Z" />
    </svg>
  );
}

export function UploadIcon({ size = 14 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

// Pick the right icon for a given mime type. The buckets mirror the
// type-filter pills (Images / Documents / Data) plus spreadsheets and
// fonts; the thumbnail pairs the icon with an extension caption, so the
// icon only needs to convey the broad family.
export function FileTypeIcon({
  mimeType,
  size = 40,
}: {
  mimeType: string | undefined;
  size?: number;
}) {
  if (!mimeType) return <FileIcon size={size} />;
  if (mimeType.startsWith("image/")) return <ImageIcon size={size} />;
  if (mimeType.startsWith("font/")) return <TypeIcon size={size} />;
  if (
    mimeType === "text/csv" ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("xlsx") ||
    mimeType.includes("excel")
  ) {
    return <SheetIcon size={size} />;
  }
  if (
    mimeType === "application/json" ||
    mimeType.includes("xml") ||
    mimeType.includes("javascript") ||
    mimeType.startsWith("text/x-")
  ) {
    return <CodeIcon size={size} />;
  }
  if (
    mimeType === "application/pdf" ||
    mimeType.includes("word") ||
    mimeType.includes("document") ||
    mimeType === "text/plain" ||
    mimeType === "text/markdown"
  ) {
    return <FileTextIcon size={size} />;
  }
  return <FileIcon size={size} />;
}
