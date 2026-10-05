import type { ToolResult } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import type { ToolSource } from "../../tools/types.ts";
import { type AccountLookup, isRecord } from "../catalog/account-lookup.ts";

/** How long one account lookup may take before the listing goes on without it. */
const ACCOUNT_LOOKUP_TIMEOUT_MS = 5_000;

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

  private async callTool(source: ToolSource, lookup: AccountLookup): Promise<string | null> {
    try {
      const result = await source.execute(
        lookup.tool,
        { ...lookup.arguments },
        AbortSignal.timeout(ACCOUNT_LOOKUP_TIMEOUT_MS),
      );
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
      }
      return label;
    } catch (err) {
      log.warn(
        `[connectors] account lookup for ${source.name} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
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
  let value: unknown = result.structuredContent ?? firstJsonText(result);
  for (const key of field.split(".")) {
    if (!isRecord(value)) return null;
    value = value[key];
  }
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length === 0 || label.length > ACCOUNT_LABEL_MAX_LENGTH) return null;
  // No control characters: a label is one line of text.
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return label;
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
