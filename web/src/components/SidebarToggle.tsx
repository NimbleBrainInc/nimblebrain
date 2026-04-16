import { ChevronLeft, ChevronRight, Menu } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "../context/SidebarContext";

export const SidebarToggle = memo(function SidebarToggle() {
  const { state, toggle } = useSidebar();

  const icon =
    state === "hidden" ? (
      <Menu style={{ width: 18, height: 18 }} />
    ) : state === "expanded" ? (
      <ChevronLeft style={{ width: 18, height: 18 }} />
    ) : (
      <ChevronRight style={{ width: 18, height: 18 }} />
    );

  const label =
    state === "hidden" ? "Open menu" : state === "expanded" ? "Collapse sidebar" : "Expand sidebar";

  if (state === "hidden") {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        aria-label={label}
        title={`${label} (⌘B)`}
        className="shrink-0"
      >
        {icon}
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={`${label} (⌘B)`}
      className="p-2 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground/60 hover:bg-sidebar-hover transition-colors shrink-0"
    >
      {icon}
    </button>
  );
});
