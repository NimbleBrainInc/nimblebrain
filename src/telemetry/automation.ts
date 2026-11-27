import { createHash } from "node:crypto";
import type { TelemetryManager } from "./manager.ts";

/**
 * An automation's id for analytics. A task's own id is derived from its name,
 * which is its owner's, so this is a hash of where it lives and that id:
 * stable for the automation's life, naming nothing.
 */
export function automationTelemetryId(wsId: string, ownerId: string, taskId: string): string {
  return createHash("sha256").update(`${wsId}/${ownerId}/${taskId}`).digest("hex").slice(0, 16);
}

/** What fires a task, from the schedule its `create` answer holds (the form it was written in). */
function triggerOf(schedule: unknown): string {
  if (!schedule || typeof schedule !== "object") return "manual";
  if ("cron" in schedule) return "cron";
  if ("intervalMs" in schedule) return "interval";
  if ("at" in schedule) return "once";
  if ("match" in schedule) return "event";
  return "manual";
}

/** The call that made the automation: who made it, and where. */
export interface AutomationCreatedBy {
  workspaceId: string;
  ownerId: string;
  /** The person's own screen made the call (`RequestContext.shellCall`); otherwise an agent did. */
  shellCall: boolean;
}

/**
 * `automation.created`, on an identified deployment, from a successful `create`
 * answer of the tasks contract: how the task is triggered, who made it, saved
 * or one-off, and its hashed id. Never its name, prompt or any other content,
 * which are its owner's. An answer with no task id sends nothing.
 */
export function captureAutomationCreated(
  telemetry: Pick<TelemetryManager, "captureAbout">,
  answer: unknown,
  by: AutomationCreatedBy,
): void {
  const task = (answer as { task?: { id?: unknown; schedule?: unknown; kind?: unknown } } | null)
    ?.task;
  if (typeof task?.id !== "string") return;
  telemetry.captureAbout(
    "automation.created",
    {
      trigger: triggerOf(task.schedule),
      created_by: by.shellCall ? "user" : "agent",
      kind: task.kind === "oneoff" ? "oneoff" : "saved",
      automation_id: automationTelemetryId(by.workspaceId, by.ownerId, task.id),
    },
    { userId: by.ownerId, workspaceId: by.workspaceId },
  );
}
