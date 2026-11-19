// ---------------------------------------------------------------------------
// ShellTour: a short look around the shell, offered once.
//
// The first time a person lands on a workspace's Overview, a centred card asks
// whether they want a quick look around; "Skip" ends it there. The tour then
// walks the real screens rather than describing them: the sidebar, the
// Overview's Apps section, the plugin catalog on Browse plugins, New skill on
// Skills, and back to the Ask box, where it leaves the cursor so it ends on something to do.
// Help → "Take the tour" replays it from any workspace page.
//
// It lives in the shell (`TourProvider` wraps `ShellLayout`) so it survives the
// route changes its steps make. The tour is controlled (`stepIndex`): on Next or
// Back it opens the page the coming step belongs on, then shows that step,
// which waits for its anchor to render. The same path serves both directions. The tour never presses anything on those pages; nothing is
// installed or created by it.
//
// Kept short on purpose: completion falls off past four or five steps, and a
// tour started by the person completes far more often than one that starts by
// itself, which is why the first step asks.
//
// Anchors are `data-tour` attributes, not test ids. On a phone the sidebar is a
// closed drawer, so its stop is left out; every other anchor may still be
// loading (the catalog fetches its list), so each step waits for its own.
//
// "Seen" is per browser (`nb:tour-seen`). It only decides whether the tour
// offers itself; the Help menu always replays it.
// ---------------------------------------------------------------------------

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACTIONS,
  EVENTS,
  type EventData,
  Joyride,
  STATUS,
  type Step,
  type TooltipRenderProps,
} from "react-joyride";
import { useLocation, useNavigate } from "react-router-dom";
import { useSidebar } from "../../context/SidebarContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { useIsMobile } from "../../lib/hooks/use-is-mobile";
import { type LocalPref, usePref, writePref } from "../../lib/local-pref";
import { toSlug } from "../../lib/workspace-slug";
import { captureEvent } from "../../telemetry";
import { Button } from "../ui/button";

const SEEN: LocalPref<boolean> = {
  key: "nb:tour-seen",
  parse: (stored) => stored === true,
  empty: false,
};

// Whether a tour is on screen, for other one-time asks to wait their turn (the
// telemetry question holds back while it runs, so a first visit asks one thing
// at a time).
let running = false;
const runningListeners = new Set<() => void>();
function setRunning(value: boolean) {
  if (running === value) return;
  running = value;
  for (const l of runningListeners) l();
}
export function useTourRunning(): boolean {
  return useSyncExternalStore(
    (l) => {
      runningListeners.add(l);
      return () => runningListeners.delete(l);
    },
    () => running,
  );
}

/** The anchor each step points at, as `[data-tour="<name>"]`. */
export type TourAnchor = "nav" | "catalog" | "skills" | "ask";

/** The workspace page a step belongs on, under `/w/<slug>/`. */
export type TourPage = "overview" | "browse" | "skills";

/** Each page's address under the workspace. */
const PAGE_PATH: Record<TourPage, string> = {
  overview: "",
  browse: "plugins/browse",
  skills: "skills",
};

const anchor = (name: TourAnchor) => `[data-tour="${name}"]`;

export interface TourStep {
  anchor: TourAnchor | null;
  page: TourPage;
  title: string;
  body: string;
  /** The primary button's word, when "Next" undersells where it goes. */
  next?: string;
}

const STEPS: TourStep[] = [
  {
    anchor: null,
    page: "overview",
    title: "Welcome to NimbleBrain",
    body: "Your agent works inside this workspace, with the plugins and skills added here. Want a one-minute look around?",
    next: "Show me around",
  },
  {
    anchor: "nav",
    page: "overview",
    title: "Your workspace",
    body: "Overview, Conversations, Files and Tasks live here. Plugins and Skills hold what your agent can do, and the apps you can open are listed below them.",
    next: "Browse plugins",
  },
  {
    anchor: "catalog",
    page: "browse",
    title: "Browse plugins",
    body: "Plugins give your agent its tools: your CRM, docs, tickets and more. Search for one, then press Install on its card. Some connect right away; others ask you to sign in to the service first. If you can't install, a workspace admin can.",
    next: "Next: skills",
  },
  {
    anchor: "skills",
    page: "skills",
    title: "Teach it with skills",
    body: "Skills tell your agent how your team works: a process, a tone, a checklist. Press New skill to write one.",
    next: "Back to Overview",
  },
  {
    anchor: "ask",
    page: "overview",
    title: "Ask your first question",
    body: 'Try "What can you do here?" or "Every Monday, brief me on what changed." Replies open in the chat (⌘J), ⌘K searches everything, and Help replays this tour.',
    next: "Done",
  },
];

/** The steps for this screen: the sidebar's is left out on a phone, where it is a closed drawer. */
export function stepsFor(mobile: boolean): TourStep[] {
  return mobile ? STEPS.filter((s) => s.anchor !== "nav") : STEPS;
}

const pathFor = (slug: string, page: TourPage) => `/w/${slug}/${PAGE_PATH[page]}`;
const samePath = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export type TourMove =
  | { kind: "end"; how: "finished" | "skipped" }
  | { kind: "go"; to: number }
  | { kind: "stay" };

/**
 * What a tour event means for a controlled tour of `count` steps. Next or Back
 * moves one step (a step whose anchor never rendered is passed over the same
 * way, in the same direction), and Next past the last step is Done: a
 * controlled tour finishes only when told.
 */
export function nextMove(
  data: Pick<EventData, "status" | "type" | "action" | "index">,
  count: number,
): TourMove {
  if (data.status === STATUS.SKIPPED) return { kind: "end", how: "skipped" };
  if (data.status === STATUS.FINISHED) return { kind: "end", how: "finished" };
  if (data.type !== EVENTS.STEP_AFTER && data.type !== EVENTS.TARGET_NOT_FOUND) {
    return { kind: "stay" };
  }
  const to = data.index + (data.action === ACTIONS.PREV ? -1 : 1);
  if (to >= count) return { kind: "end", how: "finished" };
  return to < 0 ? { kind: "stay" } : { kind: "go", to };
}

/** The card each step renders in, built from the shell's own components so it follows the theme. */
function TourCard({
  step,
  index,
  size,
  backProps,
  primaryProps,
  skipProps,
  tooltipProps,
}: TooltipRenderProps) {
  const welcome = index === 0;
  const own = (step.data as { next?: string } | undefined)?.next;
  // Spread props carry Joyride's own labels ("Next", "Last"); the visible word wins.
  const primaryLabel = own ?? "Next";
  return (
    <div
      {...tooltipProps}
      data-testid="tour-card"
      className="w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-4 text-sm text-popover-foreground shadow-md"
    >
      {step.title && <p className="font-medium">{step.title}</p>}
      <p className="mt-1.5 text-muted-foreground">{step.content}</p>
      <div className="mt-4 flex items-center gap-2">
        {welcome ? (
          <Button
            size="sm"
            variant="ghost"
            {...skipProps}
            aria-label="Skip"
            title="Skip"
            data-testid="tour-skip"
          >
            Skip
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {index} of {size - 1}
          </span>
        )}
        <span className="flex-1" />
        {!welcome && (
          <Button size="sm" variant="ghost" {...backProps} aria-label="Back" title="Back">
            Back
          </Button>
        )}
        <Button
          size="sm"
          {...primaryProps}
          aria-label={primaryLabel}
          title={primaryLabel}
          data-testid="tour-next"
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}

/** The card sits beside its target with the spotlight around it; an arrow would add nothing. */
function NoArrow() {
  return null;
}

interface TourContextValue {
  /** Starts the tour now, from the current workspace (Help → "Take the tour"). */
  start: () => void;
}

const TourContext = createContext<TourContextValue>({ start: () => {} });

export function useTour(): TourContextValue {
  return useContext(TourContext);
}

/**
 * Runs the tour for the whole shell. Offers it once per browser when a person
 * first reaches a workspace's Overview; `useTour().start()` replays it.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const seen = usePref(SEEN);
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeWorkspace } = useWorkspaceContext();
  const { setDrawerOpen } = useSidebar();
  const slug = activeWorkspace ? toSlug(activeWorkspace.id) : null;
  const [run, setRun] = useState<{ slug: string; steps: TourStep[] } | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  // Set when the tour finishes: the Ask box takes focus once the tour has
  // closed, after its focus trap hands focus back to where it found it.
  const focusAsk = useRef(false);

  const begin = useCallback(
    (origin: "first_visit" | "help") => {
      if (!slug) return;
      // On a phone, Help sits in the sidebar drawer, which is modal and would
      // cover the page the tour points at; only a navigation closes it, and the
      // first stops are on the page already open.
      setDrawerOpen(false);
      setStepIndex(0);
      setRun({ slug, steps: stepsFor(mobile) });
      captureEvent("web.tour_started", { origin });
    },
    [slug, mobile, setDrawerOpen],
  );

  // First visit: offered on a workspace's Overview, one frame after it renders
  // so its anchors exist. A cancelled frame (an effect re-run, React's double
  // mount in development) simply tries again.
  const onOverview = slug !== null && samePath(location.pathname, pathFor(slug, "overview"));
  useEffect(() => {
    if (run || seen || !onOverview) return;
    const id = requestAnimationFrame(() => begin("first_visit"));
    return () => cancelAnimationFrame(id);
  }, [run, seen, onOverview, begin]);

  useEffect(() => {
    setRunning(run !== null);
    if (!run && focusAsk.current) {
      focusAsk.current = false;
      const id = requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>(`${anchor("ask")} input`)?.focus(),
      );
      return () => cancelAnimationFrame(id);
    }
  }, [run]);

  useEffect(() => () => setRunning(false), []);

  const joyrideSteps: Step[] = useMemo(
    () =>
      (run?.steps ?? []).map((s) => ({
        target: s.anchor ? anchor(s.anchor) : "body",
        placement: s.anchor ? "auto" : "center",
        title: s.title,
        content: s.body,
        skipBeacon: true,
        data: { anchor: s.anchor, next: s.next },
      })),
    [run],
  );

  /** Ends the tour: remembered as seen, reported, and on Done the cursor goes to the Ask box. */
  const end = useCallback((how: "finished" | "skipped", step: number, steps: number) => {
    setRun(null);
    writePref(SEEN, true);
    captureEvent(how === "finished" ? "web.tour_finished" : "web.tour_skipped", { step, steps });
    if (how === "finished") focusAsk.current = true;
  }, []);

  const onEvent = useCallback(
    (data: EventData) => {
      if (!run) return;
      const move = nextMove(data, run.steps.length);
      if (move.kind === "end") return end(move.how, data.index, data.size);
      if (move.kind !== "go") return;
      const step = run.steps[move.to];
      if (!step) return;
      const path = pathFor(run.slug, step.page);
      if (!samePath(window.location.pathname + window.location.search, path)) navigate(path);
      setStepIndex(move.to);
    },
    [run, navigate, end],
  );

  const value = useMemo(() => ({ start: () => begin("help") }), [begin]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {run && (
        <Joyride
          steps={joyrideSteps}
          stepIndex={stepIndex}
          run
          continuous
          onEvent={onEvent}
          tooltipComponent={TourCard}
          arrowComponent={NoArrow}
          // The card appears whole: Joyride's 0.3s fade showed the page through
          // it, and its drop shadow doubled the card's own.
          styles={{ floater: { transition: "none", filter: "none" } }}
          options={{
            buttons: ["back", "primary", "skip"],
            overlayClickAction: false,
            spotlightRadius: 6,
            spotlightPadding: 6,
            // The sidebar and the Ask box render after the workspace loads, and
            // the catalog after its list arrives.
            targetWaitTimeout: 8000,
            zIndex: 60,
          }}
        />
      )}
    </TourContext.Provider>
  );
}
