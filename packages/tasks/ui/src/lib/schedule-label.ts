/**
 * A schedule in as few words as a list row can hold. The server writes it in
 * full ("Weekdays at 7:30 AM HST", "On notifications matching mail.*"); the
 * board shortens it ("Weekdays 7:30 AM", "On mail.* events") and drops the
 * timezone when it is the viewer's own.
 */

/** The abbreviations the server writes for a timezone (`formatTimezoneAbbr`). */
const ABBR: Record<string, string> = {
  "Pacific/Honolulu": "HST",
  "America/New_York": "EST",
  "America/Chicago": "CST",
  "America/Denver": "MST",
  "America/Los_Angeles": "PST",
  UTC: "UTC",
  "Etc/UTC": "UTC",
};

/** The viewer's timezone as the server would abbreviate it. */
export function viewerZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return ABBR[tz] ?? tz;
  } catch {
    return "";
  }
}

/** "On notifications from gmail, matching mail.*" → "On gmail mail.* events". */
function shortEvent(text: string): string {
  if (text === "On any routed notification") return "On any event";
  const from = /from ([^,]+)/.exec(text)?.[1];
  const matching = /matching ([^,]+)/.exec(text)?.[1];
  const what = [from, matching].filter(Boolean).join(" ");
  return what ? `On ${what} events` : "On events";
}

export function shortSchedule(text: string, zone: string = viewerZone()): string {
  if (!text || text === "Manual only") return "On demand";
  // A cron the server could not put into words comes back as the expression itself.
  if (/^[\d*,/\- ]+( \S+)?$/.test(text) && text.trim().split(/\s+/).length >= 5) {
    return "Custom schedule";
  }
  if (text.startsWith("On notifications") || text === "On any routed notification") {
    return shortEvent(text);
  }
  let out = text.replace(/ at (\d)/g, " $1").replace(/:00 (AM|PM)/g, " $1");
  if (zone && out.endsWith(` ${zone}`)) out = out.slice(0, -zone.length - 1);
  return out;
}
