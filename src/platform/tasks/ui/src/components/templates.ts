import type { ScheduleSpec } from "./SchedulePicker.tsx";

/** A starting point for a new task. */
export interface Template {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: ScheduleSpec | null;
}

export const TEMPLATES: Template[] = [
  {
    id: "monitor-changes",
    name: "Monitor Changes",
    description: "Check for updates on a topic every 30 minutes",
    prompt: "Check for any changes or updates to [topic] and summarize what's new.",
    schedule: { type: "interval", intervalMs: 1_800_000 },
  },
  {
    id: "weekly-summary",
    name: "Weekly Summary",
    description: "End-of-week recap of decisions and open items",
    prompt: "Summarize the week's activity, key decisions, and open items.",
    schedule: { type: "cron", expression: "0 9 * * 1", timezone: "Pacific/Honolulu" },
  },
  {
    id: "custom",
    name: "Custom",
    description: "Start from scratch",
    prompt: "",
    schedule: null,
  },
];
