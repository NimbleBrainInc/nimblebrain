import { useEffect, useRef, useState } from "react";

/** Pixels one arrow key press moves the handle. */
const KEY_STEP = 16;

interface ResizeHandleProps {
  initialWidth: number;
  onWidthChange: (width: number) => void;
  onDoubleClick?: () => void;
  min?: number;
  max?: number;
  className?: string;
}

export function ResizeHandle({
  initialWidth,
  onWidthChange,
  onDoubleClick,
  min = 280,
  max = 520,
  className,
}: ResizeHandleProps) {
  const ref = useRef<HTMLHRElement>(null);
  const cbRef = useRef(onWidthChange);
  cbRef.current = onWidthChange;

  // While dragging, render a full-viewport overlay (below). It captures the
  // mouse over everything — including app iframes, which would otherwise eat
  // the mousemove and stall the drag — so resize is fully self-contained: no
  // parent needs to know a drag is happening (no shared "isResizing" flag).
  const [dragging, setDragging] = useState(false);

  const liveWidthRef = useRef(initialWidth);
  useEffect(() => {
    liveWidthRef.current = initialWidth;
  }, [initialWidth]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let dragStartWidth = 0;

    function onMouseMove(e: MouseEvent) {
      const delta = startX - e.clientX;
      const w = Math.round(Math.max(min, Math.min(max, dragStartWidth + delta)));
      liveWidthRef.current = w;
      cbRef.current(w);
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
    }

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      startX = e.clientX;
      dragStartWidth = liveWidthRef.current;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setDragging(true);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }

    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [min, max]);

  // The panel sits right of the handle, so Left widens it and Right narrows it,
  // as a drag in that direction would.
  function onKeyDown(e: React.KeyboardEvent) {
    const step = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    const w = Math.max(min, Math.min(max, liveWidthRef.current + step));
    liveWidthRef.current = w;
    cbRef.current(w);
  }

  return (
    <>
      {/* A focusable separator is the ARIA window splitter: arrow keys resize. */}
      <hr
        ref={ref}
        tabIndex={0}
        aria-label="Resize chat panel"
        aria-orientation="vertical"
        aria-valuenow={initialWidth}
        aria-valuemin={min}
        aria-valuemax={max}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        className={`hidden sm:block m-0 w-1 shrink-0 border-0 cursor-col-resize bg-border hover:bg-ring active:bg-primary focus-visible:bg-ring focus-visible:outline-none transition-colors ${className ?? ""}`}
      />
      {dragging && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
    </>
  );
}
