import { Menu } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "../context/SidebarContext";

/**
 * Opens the mobile nav drawer from the phone header. On wider screens the
 * sidebar carries its own toggle (`SidebarHeader`).
 */
export const SidebarToggle = memo(function SidebarToggle() {
  const { toggle } = useSidebar();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label="Open menu"
      className="shrink-0"
    >
      <Menu style={{ width: 18, height: 18 }} />
    </Button>
  );
});
