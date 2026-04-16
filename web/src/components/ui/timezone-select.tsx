import { Check, ChevronDown, Globe } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const IANA_TIMEZONES: string[] =
  "supportedValuesOf" in Intl
    ? (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf(
        "timeZone",
      )
    : [
        "UTC",
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Pacific/Honolulu",
        "Europe/London",
        "Europe/Paris",
        "Asia/Tokyo",
      ];

function formatOffset(tz: string): string {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = fmt.formatToParts(now);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    return offset;
  } catch {
    return "";
  }
}

interface TimezoneSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function TimezoneSelect({ value, onChange }: TimezoneSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!search) return IANA_TIMEZONES;
    const q = search.toLowerCase();
    return IANA_TIMEZONES.filter(
      (tz) => tz.toLowerCase().includes(q) || formatOffset(tz).toLowerCase().includes(q),
    );
  }, [search]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [open]);

  // Scroll selected into view when opening
  useEffect(() => {
    if (open && value && listRef.current) {
      const el = listRef.current.querySelector(`[data-tz="${value}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [open, value]);

  const displayValue = value || "Select timezone...";

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) {
            setSearch("");
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        className={cn(
          "flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors",
          "hover:border-ring focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          !value && "text-muted-foreground",
        )}
      >
        <span className="flex items-center gap-2 truncate">
          <Globe className="shrink-0 w-3.5 h-3.5 text-muted-foreground" />
          {displayValue}
        </span>
        <ChevronDown
          className={cn(
            "shrink-0 w-3.5 h-3.5 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card shadow-lg animate-in fade-in-0 zoom-in-95 duration-100">
          {/* Search */}
          <div className="p-2 border-b border-border">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search timezones..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && filtered.length === 1) {
                  onChange(filtered[0]);
                  setOpen(false);
                }
              }}
            />
          </div>

          {/* List */}
          <div ref={listRef} className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No timezones found</div>
            ) : (
              filtered.map((tz) => (
                <button
                  key={tz}
                  type="button"
                  data-tz={tz}
                  onClick={() => {
                    onChange(tz);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-muted",
                    tz === value && "bg-muted",
                  )}
                >
                  <Check
                    className={cn(
                      "shrink-0 w-3.5 h-3.5",
                      tz === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex-1 truncate text-left">{tz.replace(/_/g, " ")}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatOffset(tz)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
