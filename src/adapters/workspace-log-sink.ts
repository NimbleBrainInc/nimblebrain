import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, EngineEventType, EventSink } from "../engine/types.ts";

/** Event types that belong in the workspace log. */
const WORKSPACE_EVENTS = new Set<EngineEventType>([
  "bundle.installed",
  "bundle.uninstalled",
  "bundle.crashed",
  "bundle.recovered",
  "bundle.dead",
  "data.changed",
  "config.changed",
  "skill.created",
  "skill.updated",
  "skill.deleted",
  "file.created",
  "file.deleted",
  "bridge.tool.done",
  "http.error",
  "audit.auth_failure",
  "audit.permission_denied",
]);

export interface WorkspaceLogConfig {
  /** Base log directory. Workspace logs go to `{dir}/workspace/`. */
  dir: string;
  /** Auto-delete log files older than this many days. No cleanup when omitted. */
  retentionDays?: number;
}

/**
 * Workspace-level JSONL event sink with daily log file rolling.
 *
 * Writes one JSON object per line to `{dir}/workspace/YYYY-MM-DD.jsonl`.
 * Only workspace and audit events are written. All other events are silently ignored.
 */
export class WorkspaceLogSink implements EventSink {
  private dir: string;

  constructor(config: WorkspaceLogConfig) {
    this.dir = join(config.dir, "workspace");
    mkdirSync(this.dir, { recursive: true });

    if (config.retentionDays != null) {
      this.cleanExpiredLogs(config.retentionDays);
    }
  }

  emit(event: EngineEvent): void {
    if (!WORKSPACE_EVENTS.has(event.type)) return;

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      event: event.type,
      ...event.data,
    };

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `${today}.jsonl`;
    appendFileSync(join(this.dir, filename), `${JSON.stringify(record)}\n`);
  }

  /** No-op — kept for API compatibility. Writes are synchronous. */
  close(): void {
    // Writes use appendFileSync, so there's nothing to flush or close.
  }

  /** Remove log files older than the retention threshold. */
  private cleanExpiredLogs(retentionDays: number): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }

    for (const file of files) {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = match[1]!;
      if (fileDate < cutoffDate) {
        try {
          unlinkSync(join(this.dir, file));
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }
}
