// ---------------------------------------------------------------------------
// SidebarSearch — global search input stub
//
// Visual stub for the eventual command palette ("apps, docs, chats" —
// the dedicated palette work lands in a separate session). For now this
// component renders the input + ⌘P keyboard shortcut chip and binds the
// shortcut to focus the field. Typing populates the input but Enter is
// a no-op; the palette session will wire query → results / navigation
// behavior on top of this surface.
//
// The shortcut listens for both Cmd+P (Mac) and Ctrl+P (others) so the
// hint hands off correctly on every platform; the chip displays ⌘P
// because Mac is the primary platform today.
// ---------------------------------------------------------------------------

import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function SidebarSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘P / Ctrl+P focuses the search input. preventDefault so the
      // browser's Print dialog doesn't steal the shortcut.
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-2 mt-1 mb-2" data-testid="sidebar-search">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-foreground/50"
          style={{ width: 14, height: 14 }}
        />
        <input
          ref={inputRef}
          type="search"
          // biome-ignore lint/a11y/noAutofocus: not autofocus — placeholder only
          placeholder="Search apps, docs, chats..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search apps, docs, chats"
          // The command palette wires actual submit / results in a later
          // session. For now the input is purely a stub focus target.
          className="w-full h-8 pl-7 pr-12 rounded-md text-sm bg-sidebar-foreground/5 border border-transparent focus:border-sidebar-foreground/20 focus:bg-sidebar-foreground/10 focus:outline-none placeholder:text-sidebar-foreground/50 text-sidebar-foreground"
        />
        <kbd
          aria-hidden="true"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-sidebar-foreground/10 text-sidebar-foreground/60 border border-sidebar-border"
        >
          ⌘P
        </kbd>
      </div>
    </div>
  );
}
