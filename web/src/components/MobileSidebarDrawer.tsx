import { Dialog } from "@base-ui/react/dialog";
import { useSidebar } from "../context/SidebarContext";

interface MobileSidebarDrawerProps {
  children: React.ReactNode;
}

export function MobileSidebarDrawer({ children }: MobileSidebarDrawerProps) {
  const { isDrawerOpen, setDrawerOpen } = useSidebar();

  return (
    <Dialog.Root open={isDrawerOpen} onOpenChange={(open) => setDrawerOpen(open)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 w-72 bg-sidebar text-sidebar-foreground shadow-xl transition-transform duration-300 ease-out data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full overflow-y-auto">
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
