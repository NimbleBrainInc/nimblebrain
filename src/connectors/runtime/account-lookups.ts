import type { ToolResult } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import type { ToolSource } from "../../tools/types.ts";
import { type AccountLookup, isRecord } from "../catalog/account-lookup.ts";

/** How long one account lookup may take before the listing goes on without it. */
const DEFAULT_ACCOUNT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * How long a connection is left alone after a lookup that named no account. A
 * listing is read on every page load, and a lookup that failed once (the tool
 * errored, the catalog's `field` is wrong) fails the same way on the next.
 */
const ACCOUNT_LOOKUP_RETRY_MS = 5 * 60_000;

/**
 * Asks connected connectors which account they are signed in as, at most once
 * at a time per connection.
 *
 * Process-local on purpose: a successful answer is stored with the connection
 * by the caller, so all that lives here is the lookups in flight and the
 * recent failures, and losing either costs one repeated tool call. Both are
 * held per source object. A new sign-in builds a new source, so it is asked
 * afresh whatever the last one answered, and a source that is gone takes its
 * entry with it.
 */
export class AccountLookups {
  private readonly inFlight = new WeakMap<ToolSource, Promise<string | null>>();
  private readonly failedAt = new WeakMap<ToolSource, number>();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_ACCOUNT_LOOKUP_TIMEOUT_MS;
  }

  /**
   * The account label `source` answers for `lookup`, or null. Never throws.
   * Concurrent asks of one source share one tool call.
   */
  ask(source: ToolSource, lookup: AccountLookup): Promise<string | null> {
    const pending = this.inFlight.get(source);
    if (pending) return pending;
    const failed = this.failedAt.get(source);
    if (failed !== undefined && Date.now() - failed < ACCOUNT_LOOKUP_RETRY_MS) {
      return Promise.resolve(null);
    }
    const asking = this.callTool(source, lookup)
      .then((label) => {
        if (label === null) this.failedAt.set(source, Date.now());
        return label;
      })
      .finally(() => {
        this.inFlight.delete(source);
      });
    this.inFlight.set(source, asking);
    return asking;
  }

  /**
   * One call of the declared tool, answered within `timeoutMs` whatever the
   * source does: `execute` may recover a torn connection on its own schedule,
   * which the signal does not cut short, so the listing races it rather than
   * waits on it. Inline, never as a task: a label is not work to hand a
   * server.
   */
  private async callTool(source: ToolSource, lookup: AccountLookup): Promise<string | null> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        source.execute(lookup.tool, { ...lookup.arguments }, signal, { inline: true }),
        timedOut,
      ]);
      if (result === null) {
        log.warn(
          `[connectors] account lookup for ${source.name} timed out after ${this.timeoutMs}ms`,
        );
        return null;
      }
      const label = accountLabelFrom(result, lookup.field);
      if (label === null) {
        // Says which half failed without logging the answer, which is the
        // service's data about a person.
        log.warn(
          `[connectors] account lookup for ${source.name} named no account: ` +
            (result.isError
              ? `tool "${lookup.tool}" returned an error`
              : `no label at "${lookup.field}" in the answer of "${lookup.tool}"`),
        );
      } else {
        log.debug("mcp", `[connectors] account lookup for ${source.name} named the account`);
      }
      return label;
    } catch (err) {
      log.warn(
        `[connectors] account lookup for ${source.name} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Longest label kept: the length of the longest valid email address. */
const ACCOUNT_LABEL_MAX_LENGTH = 254;

/**
 * The account label in a tool's answer, or null when the answer has none at
 * `field`. The answer is the result's `structuredContent`, or its first text
 * block read as JSON.
 *
 * The label is shown to people and handed to the agent in a connector listing,
 * and the service wrote it, so only a short single-line string is kept.
 */
export function accountLabelFrom(result: ToolResult, field: string): string | null {
  if (result.isError) return null;
  const label = labelAt(result.structuredContent, field) ?? labelAt(firstJsonText(result), field);
  if (label === null || label.length > ACCOUNT_LABEL_MAX_LENGTH) return null;
  // One line of text: no control, format or line-separator characters.
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(label)) return null;
  return label;
}

/** The non-empty string at `field` in `answer`, or null. */
function labelAt(answer: unknown, field: string): string | null {
  let value: unknown = answer;
  for (const key of field.split(".")) {
    if (!isRecord(value)) return null;
    value = value[key];
  }
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length === 0 ? null : label;
}

function firstJsonText(result: ToolResult): unknown {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    try {
      return JSON.parse(block.text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
