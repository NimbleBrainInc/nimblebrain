import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutItem[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "Chat",
    shortcuts: [
      { keys: ["⌘", "K"], description: "Open / close chat" },
      { keys: ["⌘", "⇧", "K"], description: "Expand / collapse" },
      { keys: ["Esc"], description: "Close chat" },
    ],
  },
  {
    title: "Sidebar",
    shortcuts: [{ keys: ["⌘", "B"], description: "Toggle sidebar" }],
  },
  {
    title: "Input",
    shortcuts: [
      { keys: ["Enter"], description: "Send message" },
      { keys: ["⇧", "Enter"], description: "New line" },
      { keys: ["/clear"], description: "New conversation" },
    ],
  },
  {
    title: "General",
    shortcuts: [{ keys: ["?"], description: "Show keyboard shortcuts" }],
  },
];

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={modalRef}
        className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-heading text-lg font-medium text-foreground">Keyboard Shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-muted rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
          {shortcutGroups.map((group, groupIndex) => (
            <div key={group.title} className={groupIndex > 0 ? "mt-6" : ""}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static shortcut list
                  <div key={index} className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-muted-foreground">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, keyIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static shortcut list
                        <span key={keyIndex}>
                          <kbd className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-1 text-xs font-mono font-medium bg-muted text-foreground rounded border border-border">
                            {key}
                          </kbd>
                          {keyIndex < shortcut.keys.length - 1 && (
                            <span className="text-muted-foreground mx-0.5">+</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border bg-muted/50">
          <p className="text-xs text-muted-foreground text-center">
            Press{" "}
            <kbd className="px-1 py-0.5 text-[10px] font-mono bg-card rounded border border-border">
              ?
            </kbd>{" "}
            anytime to show this
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
