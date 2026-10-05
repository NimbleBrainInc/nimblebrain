import type { ReactNode } from "react";

const STATUS_PATHS: Record<string, ReactNode> = {
  success: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  warning: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  active: <path d="M21 12a9 9 0 1 1-6.22-8.56" />,
  muted: <circle cx="12" cy="12" r="10" strokeDasharray="3 3" />,
};

/** A status as an icon, in its tone's colour (set by the parent's `tone-*` class). */
export function StatusIcon({
  tone,
}: {
  tone: "success" | "danger" | "warning" | "active" | "muted";
}) {
  return (
    <svg
      aria-hidden="true"
      className={`status-icon${tone === "active" ? " spin" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {STATUS_PATHS[tone]}
    </svg>
  );
}
