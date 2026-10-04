/**
 * Logs each use of a retired tool name, once per (caller, name), so we can tell
 * when callers have moved to the current name and the alias can be removed.
 *
 * In memory and per process: a restart logs each pair again, which is the
 * point — the question is "is anyone still calling it", asked of recent logs.
 * The set is capped so a long-lived process cannot grow it without bound; when
 * full it starts over, which at worst logs a pair twice.
 */

import { log } from "../observability/log.ts";
import { canonicalIdentityToolName } from "./identity-sources.ts";

const MAX_NOTED = 10_000;
const noted = new Set<string>();

/**
 * If `toolName` uses a retired identity-source name, log it (once per caller)
 * with the name to use instead. A no-op for every current name.
 *
 * `door` names where the call came in (`route` for `/mcp` and agent runs,
 * `rest` for `POST …/tools/call`), since a caller that moves on one door may
 * still use the old name on another.
 */
export function noteRetiredToolName(
  toolName: string,
  callerId: string | undefined,
  door: string,
): void {
  const current = canonicalIdentityToolName(toolName);
  if (current === toolName) return;
  const key = `${callerId ?? ""}\u0000${door}\u0000${toolName}`;
  if (noted.has(key)) return;
  if (noted.size >= MAX_NOTED) noted.clear();
  noted.add(key);
  log.info("[tasks] retired tool name called; use the current name", {
    tool: toolName,
    use: current,
    caller: callerId,
    door,
  });
}

/** Forget every logged pair. Tests only. */
export function resetRetiredToolNamesForTest(): void {
  noted.clear();
}
