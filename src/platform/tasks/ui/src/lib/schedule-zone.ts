/**
 * The timezone a schedule's clock times are read in. A time typed into the
 * form is on the clock of whoever typed it, so a schedule keeps the timezone it
 * already has (an edit never moves a stored schedule's times), and otherwise
 * takes the viewer's. With neither, no timezone is sent and the server reads it
 * in the instance's.
 */
import type { ScheduleSpec } from "../components/SchedulePicker.tsx";

/** The viewer's own IANA timezone, as the browser reports it; undefined when it cannot say. */
export function viewerTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The schedule's own timezone, else the viewer's. */
export function scheduleZone(
  current: ScheduleSpec | null,
  viewer: string | undefined,
): string | undefined {
  return current?.timezone ?? viewer;
}

/** A cron schedule with the timezone its times are read in; any other kind is returned as it is. */
export function inZone(spec: ScheduleSpec, viewer: string | undefined): ScheduleSpec {
  if (spec.type !== "cron") return spec;
  const zone = scheduleZone(spec, viewer);
  return zone ? { ...spec, timezone: zone } : spec;
}
