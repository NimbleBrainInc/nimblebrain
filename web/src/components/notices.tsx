// ---------------------------------------------------------------------------
// Notices — the app-level tier of user feedback.
//
// Feedback has three tiers, and a surface picks the narrowest that works:
//
//   field   inline on the control it is about (saving, saved, rejected value)
//   page    a banner on the page (`InlineError`: the page failed to load)
//   app     a notice: transient, outside the page, can carry an action (Undo)
//
// A notice has one of four levels. The level sets its color and icon, how long
// it stays, and how a screen reader announces it:
//
//   success  a change landed                    closes after 5s    polite
//   info     something worth knowing            closes after 6s    polite
//   warning  it worked, with a consequence      stays until closed polite
//   error    it did not happen                  stays until closed assertive
//
// `NoticeProvider` wraps the app once and `useNotice()` raises a notice.
// `NoticeViewport` is where they appear: `ShellLayout` renders it in the
// bottom-right of the main column, so a notice never covers the docked chat.
// ---------------------------------------------------------------------------

import { Toast } from "@base-ui/react/toast";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { cn } from "../lib/utils";

export type NoticeLevel = "success" | "info" | "warning" | "error";

export interface Notice {
  level: NoticeLevel;
  title: string;
  description?: string;
  /** One action, such as Undo. Raising it closes the notice. */
  action?: { label: string; onClick: () => void };
}

const LEVELS: Record<
  NoticeLevel,
  {
    timeout: number;
    priority: "low" | "high";
    icon: LucideIcon;
    surface: string;
    iconClass: string;
  }
> = {
  success: {
    timeout: 5000,
    priority: "low",
    icon: CheckCircle2,
    surface: "bg-[color-mix(in_oklab,var(--success)_12%,var(--popover))] border-success/40",
    iconClass: "text-success",
  },
  info: {
    timeout: 6000,
    priority: "low",
    icon: Info,
    surface: "bg-info-light border-primary/30",
    iconClass: "text-primary",
  },
  warning: {
    timeout: 0,
    priority: "low",
    icon: AlertTriangle,
    surface: "bg-[color-mix(in_oklab,var(--warning)_14%,var(--popover))] border-warning/50",
    iconClass: "text-warning",
  },
  error: {
    timeout: 0,
    priority: "high",
    icon: AlertCircle,
    surface: "bg-[color-mix(in_oklab,var(--destructive)_12%,var(--popover))] border-destructive/50",
    iconClass: "text-destructive",
  },
};

type Notify = (notice: Notice) => void;

const NoticeContext = createContext<Notify | null>(null);

/** Raise a notice. Throws outside `NoticeProvider`, so a missing provider fails loudly. */
export function useNotice(): Notify {
  const notify = useContext(NoticeContext);
  if (!notify) throw new Error("useNotice must be used inside NoticeProvider");
  return notify;
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={3}>
      <NoticeBridge>{children}</NoticeBridge>
    </Toast.Provider>
  );
}

/** Adapts Base UI's toast manager to the `Notice` shape callers use. */
function NoticeBridge({ children }: { children: ReactNode }) {
  const manager = Toast.useToastManager();
  const notify = useMemo<Notify>(
    () => (notice) => {
      const id = crypto.randomUUID();
      const level = LEVELS[notice.level];
      const action = notice.action;
      manager.add({
        id,
        type: notice.level,
        title: notice.title,
        description: notice.description,
        timeout: level.timeout,
        priority: level.priority,
        actionProps: action
          ? {
              children: action.label,
              onClick: () => {
                action.onClick();
                manager.close(id);
              },
            }
          : undefined,
      });
    },
    [manager],
  );
  return <NoticeContext.Provider value={notify}>{children}</NoticeContext.Provider>;
}

/**
 * Where notices appear: the bottom-right corner of the nearest positioned
 * ancestor. `ShellLayout` places it in the main column.
 */
export function NoticeViewport() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Viewport className="absolute right-4 bottom-4 z-50 flex w-[min(22rem,calc(100%-2rem))] flex-col gap-2 outline-none">
      {toasts.map((toast) => {
        const level = LEVELS[(toast.type as NoticeLevel) ?? "info"] ?? LEVELS.info;
        const Icon = level.icon;
        return (
          <Toast.Root
            key={toast.id}
            toast={toast}
            data-testid="notice"
            data-level={toast.type}
            className={cn(
              "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-foreground shadow-lg",
              "transition-[opacity,translate] duration-150 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 motion-reduce:transition-none",
              level.surface,
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", level.iconClass)} aria-hidden="true" />
            <Toast.Content className="min-w-0 flex-1">
              <Toast.Title className="text-sm font-medium" />
              <Toast.Description className="mt-0.5 text-sm text-muted-foreground" />
            </Toast.Content>
            {toast.actionProps ? (
              <Toast.Action className="shrink-0 rounded-sm px-2 py-0.5 text-sm font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
            ) : null}
            <Toast.Close
              aria-label="Dismiss"
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="h-3.5 w-3.5" />
            </Toast.Close>
          </Toast.Root>
        );
      })}
    </Toast.Viewport>
  );
}
