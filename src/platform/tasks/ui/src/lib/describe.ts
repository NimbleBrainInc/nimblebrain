/**
 * The message the Scheduled page's describe box hands to the agent. It carries
 * the viewer's timezone when the browser reports one, so the agent reads "9am"
 * on the viewer's clock instead of asking which clock it is.
 */
export function describeMessage(sentence: string, timezone: string | undefined): string {
  const zone = timezone ? ` My timezone is ${timezone}.` : "";
  return `Set up a scheduled task: ${sentence}\n\n${zone.trim() ? `${zone.trim()} ` : ""}Ask me anything you need to know, then show me what you set up.`;
}

/** The strip's label: how many recent runs it shows, and each run's outcome. */
export function stripLabel(words: string[]): string {
  if (!words.length) return "No runs yet";
  return `Last ${words.length === 1 ? "run" : `${words.length} runs`}: ${words.join(", ")}`;
}
