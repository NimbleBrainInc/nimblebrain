/**
 * The message "Schedule this" sends: the person's own request, quoted, handed
 * to the agent to save as a scheduled task. The agent asks what it needs (when,
 * where the result goes) and saves it with `tasks__create`, whose card then
 * shows what was saved.
 */
export function scheduleThisMessage(request: string): string {
  const quoted = request
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "Make this a scheduled task:",
    "",
    quoted,
    "",
    "Ask me when it should run and where the result should go, then show me what you set up.",
  ].join("\n");
}
