import type { InstalledConnector } from "../../api/client";

/**
 * A connector's status in a list row. Only non-ready states say anything, so
 * a clean row stays clean. Action verbs lead the user to the right next step:
 *
 *   needs_setup + missingOAuthClient → "Set up"
 *   not_connected → "Not connected" (neutral — at rest, nothing is broken)
 *   needs_auth → "Reconnect" (a working connection broke)
 *   failed → "Failed" (no verb — admin investigates on the detail page)
 *   connecting / starting → "Connecting…" (no verb, no chevron action)
 *
 * Returns `null` for the ready state so the row renders without any status
 * block: "this one's fine, nothing to do." The Plugins page shows a plugin's
 * servers with these words.
 */
export interface ConnectorStatusSummary {
  label: string;
  tone: string;
  dot: boolean;
  dotColor: string;
}

export function connectorStatusSummary(
  status: InstalledConnector["status"],
  missingOAuthClient?: boolean,
): ConnectorStatusSummary | null {
  switch (status) {
    case "ready":
      return null;
    case "needs_setup": {
      const verb = missingOAuthClient ? "Set up" : "Configure";
      return { label: verb, tone: "text-amber-600", dot: true, dotColor: "bg-amber-500" };
    }
    case "not_connected":
      return {
        label: "Not connected",
        tone: "text-muted-foreground",
        dot: true,
        dotColor: "bg-muted-foreground/50",
      };
    case "needs_auth":
      return { label: "Reconnect", tone: "text-amber-600", dot: true, dotColor: "bg-amber-500" };
    case "connecting":
    case "starting":
      return {
        label: "Connecting…",
        tone: "text-muted-foreground",
        dot: true,
        dotColor: "bg-blue-500 animate-pulse",
      };
    case "failed":
      return { label: "Failed", tone: "text-destructive", dot: true, dotColor: "bg-rose-500" };
  }
}
