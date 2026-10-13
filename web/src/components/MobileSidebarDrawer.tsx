import { Dialog } from "@base-ui/react/dialog";
import { useSidebarClass } from "../brand";
import { useSidebar } from "../context/SidebarContext";
import { cn } from "../lib/utils";

interface MobileSidebarDrawerProps {
  children: React.ReactNode;
}

export function MobileSidebarDrawer({ children }: MobileSidebarDrawerProps) {
  const { isDrawerOpen, setDrawerOpen } = useSidebar();
  const sidebarClass = useSidebarClass();

  return (
    <Dialog.Root open={isDrawerOpen} onOpenChange={(open) => setDrawerOpen(open)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-72 bg-sidebar text-sidebar-foreground shadow-xl transition-transform duration-300 ease-out data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full overflow-y-auto",
            sidebarClass,
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
