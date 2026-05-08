import { type ReactNode, useState } from "react";

/**
 * Collapse / disclose wrapper for sections that are useful but
 * verbose. The Tool permissions table is the canonical case: 12+ rows
 * of Allow / Disallow buttons that drown the rest of the Configure
 * page. Most users want the page-level status + connection details
 * first; per-tool permissions are tuning, not primary content.
 *
 * The disclosure is uncontrolled by default — `defaultOpen` sets the
 * initial state — so the parent doesn't have to manage open/close
 * unless it wants to coordinate with another section.
 *
 * Lazy-mounts children on first expand. The Tool permissions table
 * fetches on mount; rendering it eagerly would fire two REST calls
 * for every Configure page load even when the user never opens the
 * section. Mounting on first expand defers that cost; collapsing
 * doesn't unmount, so subsequent toggles are free.
 */
export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  /** Section heading. Renders in the same uppercase-tracking style as the other sections. */
  title: string;
  /**
   * Short content rendered next to the title when collapsed. Helps
   * the user decide whether to open it without reading the body.
   */
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [hasOpened, setHasOpened] = useState(defaultOpen);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) setHasOpened(true);
  };

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-3 group text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <Chevron open={open} />
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide group-hover:text-foreground transition-colors">
            {title}
          </h2>
        </div>
        {summary && !open && (
          <span className="text-xs text-muted-foreground truncate">{summary}</span>
        )}
      </button>
      {open && (
        <div className="pl-5">
          {/* Once the user has opened the section we keep the children
              mounted so subsequent open/close cycles don't re-fetch. */}
          {hasOpened ? children : null}
        </div>
      )}
    </section>
  );
}

/** Right-pointing when closed, down-pointing when open. SVG is
 *  inline because importing an icon library for one chevron is
 *  overkill, and the existing UI doesn't have a stock chevron. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`text-muted-foreground transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path
        d="M3 1.5L7 5L3 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
