// ---------------------------------------------------------------------------
// OverviewTour — a short look around the shell, offered once.
//
// The first time a person lands on a workspace's Overview, a centred card asks
// whether they want a quick look around; "Skip" ends it there. The tour points
// at four places and ends with the cursor in the Ask box, so it finishes on
// something to do rather than on reading. Help → "Take the tour" replays it
// (through `?tour=1` on the Overview route).
//
// Kept short on purpose: completion falls off past four or five steps, and a
// tour started by the person completes far more often than one that starts by
// itself, which is why the first step asks.
//
// Anchors are `data-tour` attributes on the shell, not test ids. The sidebar's
// steps are left out on a phone, where the sidebar is a closed drawer; every
// other anchor may still be loading, so each step waits for its own.
//
// "Seen" is per browser (`nb:tour-seen`). It only decides whether the tour
// offers itself; the Help menu always replays it.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type EventData, Joyride, STATUS, type Step, type TooltipRenderProps } from "react-joyride";
import { useIsMobile } from "../../lib/hooks/use-is-mobile";
import { type LocalPref, usePref, writePref } from "../../lib/local-pref";
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
export type TourAnchor = "nav" | "ask" | "chat" | "help";

const anchor = (name: TourAnchor) => `[data-tour="${name}"]`;

interface TourStep {
  anchor: TourAnchor | null;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    anchor: null,
    title: "Welcome to NimbleBrain",
    body: "Your agent works inside this workspace, with the apps installed here. Want a one-minute look around?",
  },
  {
    anchor: "nav",
    title: "Your workspace",
    body: "Overview, Conversations, Files and Tasks live here, and below them the apps installed in this workspace. Add an app to connect the tools your agent can use.",
  },
  {
    anchor: "chat",
    title: "Chat with your agent",
    body: "Open the chat from any page (⌘J). It stays docked beside whatever you are looking at.",
  },
  {
    anchor: "help",
    title: "Find anything",
    body: "Press ⌘K to search conversations, files and apps. Replay this tour from Help any time.",
  },
  {
    anchor: "ask",
    title: "Ask your first question",
    body: 'Try "What can you do in this workspace?", or "Every Monday at 8am, brief me on what changed this week."',
  },
];

function toJoyrideSteps(steps: TourStep[]): Step[] {
  return steps.map((s) => ({
    target: s.anchor ? anchor(s.anchor) : "body",
    placement: s.anchor ? "auto" : "center",
    title: s.title,
    content: s.body,
    skipBeacon: true,
    data: { anchor: s.anchor },
  }));
}

/** The sidebar's anchors; on a phone the sidebar is a closed drawer. */
const SIDEBAR: ReadonlySet<TourAnchor | null> = new Set(["nav", "help"]);

/** The steps for this screen: the sidebar's are left out on a phone. */
export function stepsFor(mobile: boolean): TourStep[] {
  return mobile ? STEPS.filter((s) => !SIDEBAR.has(s.anchor)) : STEPS;
}

/** The card each step renders in, built from the shell's own components so it follows the theme. */
function TourCard({
  step,
  index,
  size,
  isLastStep,
  backProps,
  primaryProps,
  skipProps,
  tooltipProps,
}: TooltipRenderProps) {
  const welcome = index === 0;
  // Spread props carry Joyride's own labels ("Next", "Last"); the visible word wins.
  const primaryLabel = welcome ? "Show me around" : isLastStep ? "Done" : "Next";
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

/**
 * Runs the tour on the Overview page. `replay` starts it now (Help → "Take the
 * tour"); otherwise it offers itself once per browser, on first arrival.
 * `onEnd` runs when it stops for any reason.
 */
export function OverviewTour({ replay, onEnd }: { replay: boolean; onEnd?: () => void }) {
  const seen = usePref(SEEN);
  const mobile = useIsMobile();
  const [run, setRun] = useState(false);
  const [steps, setSteps] = useState<TourStep[]>([]);
  // A replay starts once per `?tour=1`: the tour ends before the page drops the
  // param, and reading the still-present param again would start it over.
  const replayStarted = useRef(false);

  useEffect(() => {
    if (!replay) replayStarted.current = false;
    if (run) return;
    const origin =
      replay && !replayStarted.current ? "help" : !replay && !seen ? "first_visit" : null;
    if (!origin) return;
    // One frame later, so the shell's anchors have rendered. The replay is
    // marked started only here: a cancelled frame (an effect re-run, React's
    // double mount in development) must leave it able to start.
    const id = requestAnimationFrame(() => {
      if (origin === "help") replayStarted.current = true;
      setSteps(stepsFor(mobile));
      setRun(true);
      captureEvent("web.tour_started", { origin });
    });
    return () => cancelAnimationFrame(id);
  }, [replay, seen, run, mobile]);

  useEffect(() => {
    setRunning(run);
    return () => setRunning(false);
  }, [run]);

  const joyrideSteps = useMemo(() => toJoyrideSteps(steps), [steps]);

  const onEvent = useCallback(
    (data: EventData) => {
      if (data.status !== STATUS.FINISHED && data.status !== STATUS.SKIPPED) return;
      setRun(false);
      writePref(SEEN, true);
      captureEvent(data.status === STATUS.FINISHED ? "web.tour_finished" : "web.tour_skipped", {
        step: data.index,
        steps: data.size,
      });
      // Ends on something to do: the cursor in the Ask box, once the tour's
      // focus trap has let go.
      if (data.status === STATUS.FINISHED) {
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>(`${anchor("ask")} input`)?.focus(),
        );
      }
      onEnd?.();
    },
    [onEnd],
  );

  if (!run) return null;
  return (
    <Joyride
      steps={joyrideSteps}
      run={run}
      continuous
      onEvent={onEvent}
      tooltipComponent={TourCard}
      arrowComponent={NoArrow}
      // The card appears whole: Joyride's 0.3s fade showed the page through it,
      // and its drop shadow doubled the card's own.
      styles={{ floater: { transition: "none", filter: "none" } }}
      options={{
        buttons: ["back", "primary", "skip"],
        overlayClickAction: false,
        spotlightRadius: 6,
        spotlightPadding: 6,
        // The sidebar and the Ask box render after the workspace loads.
        targetWaitTimeout: 5000,
        zIndex: 60,
      }}
    />
  );
}

/** The card sits beside its target with the spotlight around it; an arrow would add nothing. */
function NoArrow() {
  return null;
}
