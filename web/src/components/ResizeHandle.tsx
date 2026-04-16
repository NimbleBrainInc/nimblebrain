import { useEffect, useRef } from "react";

interface ResizeHandleProps {
  initialWidth: number;
  onWidthChange: (width: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  min?: number;
  max?: number;
  className?: string;
}

export function ResizeHandle({
  initialWidth,
  onWidthChange,
  onDragStart,
  onDragEnd,
  onDoubleClick,
  min = 280,
  max = 520,
  className,
}: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onWidthChange);
  cbRef.current = onWidthChange;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

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
      onDragEndRef.current?.();
    }

    function onMouseDown(e: MouseEvent) {
      e.preventDefault();
      startX = e.clientX;
      dragStartWidth = liveWidthRef.current;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      onDragStartRef.current?.();
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

  // biome-ignore lint/a11y/noStaticElementInteractions: drag handle uses pointer events for resize
  return (
    <div
      ref={ref}
      onDoubleClick={onDoubleClick}
      className={`hidden sm:block w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring active:bg-primary transition-colors ${className ?? ""}`}
    />
  );
}
