import type { ScheduleSpec } from "./SchedulePicker.tsx";

/**
 * An example to start from: the sentence a person would say, and the same
 * job as a prompt and schedule for the form.
 */
export interface Template {
  id: string;
  /** What a person would say to set it up, sent to chat as written. */
  sentence: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec | null;
}

export const TEMPLATES: Template[] = [
  {
    id: "morning-digest",
    sentence: "Every weekday at 7am, summarize my unread email and tell me what needs a reply",
    name: "Morning email digest",
    prompt:
      "Summarize my unread email from the last day: who wrote, what they ask, and anything due today. List the ones that need a reply first.",
    schedule: { type: "cron", expression: "0 7 * * 1-5" },
  },
  {
    id: "weekly-summary",
    sentence: "Every Friday at 4pm, recap the week's decisions and open items",
    name: "Weekly recap",
    prompt: "Summarize the week's activity, key decisions, and open items.",
    schedule: { type: "cron", expression: "0 16 * * 5" },
  },
  {
    id: "watch-page",
    sentence: "Every 6 hours, check a web page for changes and tell me what's new",
    name: "Watch a page",
    prompt: "Check [page or topic] for changes since the last check and summarize what's new.",
    schedule: { type: "interval", intervalMs: 6 * 3_600_000 },
  },
];
