// ---------------------------------------------------------------------------
// greeting — time-of-day greeting for the global Home page header
//
// Computed from the local clock; deliberately not internationalized — i18n
// arrives when the rest of the shell does.
// ---------------------------------------------------------------------------

export function getGreeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
