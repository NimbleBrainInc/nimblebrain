import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../engine/types.ts";

export interface StructuredLogConfig {
  /** Directory to write log files. Created if missing. */
  dir: string;
  /** Conversation ID for correlating log entries. */
  conversationId?: string;
  /** User ID for correlating log entries. */
  userId?: string;
  /** Workspace ID for correlating log entries. */
  workspaceId?: string;
  /** Auto-delete log files older than this many days. No cleanup when omitted. */
  retentionDays?: number;
}

/** Noisy event-specific fields excluded from log records. */
const EXCLUDED_FIELDS = new Set([
  "toolNames",
  "systemPromptLength",
  "systemPrompt",
  "messageRoles",
  "estimatedMessageTokens",
]);

/**
 * Structured JSONL event sink with daily log file rolling.
 *
 * Writes one JSON object per line to `{dir}/nimblebrain-YYYY-MM-DD.jsonl`.
 * A new file is created each day automatically.
 *
 * This is a pass-through writer — every event (except text.delta) is written
 * as-is with no accumulation or derived values. Cost, totals, and breakdowns
 * are computed at read/query time, not at write time.
 */
export class StructuredLogSink implements EventSink {
  private dir: string;
  private conversationId: string | undefined;
  private userId: string | undefined;
  private workspaceId: string | undefined;

  constructor(config: StructuredLogConfig) {
    this.dir = config.dir;
    this.conversationId = config.conversationId;
    this.userId = config.userId;
    this.workspaceId = config.workspaceId;
    mkdirSync(this.dir, { recursive: true });

    if (config.retentionDays != null) {
      this.cleanExpiredLogs(config.retentionDays);
    }
  }

  setConversationId(id: string): void {
    this.conversationId = id;
  }

  setUserId(id: string): void {
    this.userId = id;
  }

  setWorkspaceId(id: string): void {
    this.workspaceId = id;
  }

  emit(event: EngineEvent): void {
    // Skip text.delta — too noisy for logs
    if (event.type === "text.delta") return;

    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      event: event.type,
      ...(this.conversationId ? { sid: this.conversationId } : {}),
      ...(this.userId ? { uid: this.userId } : {}),
      ...(this.workspaceId ? { wsId: this.workspaceId } : {}),
    };

    for (const [key, value] of Object.entries(event.data)) {
      if (EXCLUDED_FIELDS.has(key)) continue;
      record[key] = value;
    }

    this.writeLine(record);
  }

  /** No-op — kept for API compatibility. Writes are synchronous. */
  close(): void {
    // Writes use appendFileSync, so there's nothing to flush or close.
  }

  private writeLine(record: Record<string, unknown>): void {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `nimblebrain-${today}.jsonl`;
    appendFileSync(join(this.dir, filename), `${JSON.stringify(record)}\n`);
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
      return; // Directory may not exist yet on first run
    }

    for (const file of files) {
      // Match nimblebrain-YYYY-MM-DD.jsonl
      const match = file.match(/^nimblebrain-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const fileDate = match[1]!;
      if (fileDate < cutoffDate) {
        try {
          unlinkSync(join(this.dir, file));
        } catch {
          // Best-effort cleanup — don't fail startup over stale log deletion
        }
      }
    }
  }
}
