/**
 * Spend accounts: what a run may spend, reserved before each model call and
 * debited after it.
 *
 * Asserted at the run-start door (`Runtime.startRun`), so every source that
 * starts runs inherits it (ADR-0045). A run's description names a list of
 * accounts, each an opaque id the source chose, with a unit and the amount
 * remaining. The door keeps ONE live balance per id for as long as any run
 * naming it is in flight: the first run to name an id sets its unit and
 * balance, and every later run naming it draws on that same balance. The
 * balance is discarded when the last run naming the id ends; the source
 * re-issues the remaining amount on its next run, from the usage the run
 * reported.
 *
 * Runs sharing an account cannot together exceed it because each call
 * reserves its worst case before it is sent: `check` clamps the call's output
 * to what the account has left after every other reservation (balance minus
 * outstanding reservations), and reserves the projected input plus that
 * output. `debit` releases the call's reservation and subtracts what it
 * actually cost; ending the run releases any reservation still outstanding.
 * A call cannot write more than its clamped output, so the only way past a
 * balance is input beyond the projection (the prompt estimate undercounting):
 * the debit takes the real amount, and the balance goes negative by at most
 * that excess.
 *
 * The door never interprets an id. Whether one stands for a batch, a task, or
 * a workspace is the source's knowledge, so nothing here branches on it.
 */

import type { SpendGate } from "../engine/types.ts";
import { costBreakdown } from "../usage/cost.ts";
import type { TokenUsage, UsageRates } from "../usage/types.ts";

/** What an account is denominated in. */
export type SpendUnit = "usd" | "input_tokens" | "output_tokens";

/** One account a run names. */
export interface SpendAccount {
  /** Opaque, chosen by the source. Runs naming the same id share one balance. */
  id: string;
  unit: SpendUnit;
  /** The amount left, in `unit`. Read only from the first run to name `id`. */
  remaining: number;
}

/**
 * How a model call is costed in each unit. `usd` debits with the run model's
 * rates, the same arithmetic as `costBreakdown`.
 */
export interface SpendPricing {
  rates: UsageRates | null;
  model: string;
}

/**
 * The accounts one run holds open: the engine's `SpendGate`, plus the end of
 * the run.
 */
export interface SpendHold extends SpendGate {
  /**
   * Stop holding the accounts, releasing any outstanding reservation. The last
   * run to release an id discards its balance. Idempotent.
   */
  release(): void;
}

export interface SpendBalances {
  /** Hold `accounts` open for one run. */
  open(accounts: readonly SpendAccount[], pricing: SpendPricing): SpendHold;
  /** The live balance of `id` (reservations not subtracted), or undefined when no run in flight names it. */
  balance(id: string): number | undefined;
}

/**
 * What `usage` actually cost in `unit`. A `usd` amount on a model with no
 * known rates is 0, since nothing is known to have been charged.
 */
export function spendIn(unit: SpendUnit, usage: TokenUsage, pricing: SpendPricing): number {
  switch (unit) {
    case "input_tokens":
      return usage.inputTokens;
    case "output_tokens":
      return usage.outputTokens;
    case "usd":
      return pricing.rates ? costBreakdown(pricing.model, usage, pricing.rates).total : 0;
  }
}

/** Worst-case dollars per token, or null for a model with no known rates. */
type WorstRates = { input: number; output: number } | null;

/**
 * Worst-case dollars per input and per output token. Projected input is
 * priced at the dearest input-side rate (a cache write can bill above base
 * input), and output at the dearer of output and reasoning, so a call's
 * projection is never below what the same tokens can cost.
 */
function worstRates(rates: UsageRates): NonNullable<WorstRates> {
  return {
    input: Math.max(rates.input, rates.cacheRead, rates.cacheWrite5m, rates.cacheWrite1h) / 1e6,
    output: Math.max(rates.output, rates.reasoning ?? 0) / 1e6,
  };
}

/**
 * The most output `available` in `unit` pays for alongside the call's input,
 * or null when the input alone does not fit. An `input_tokens` account never
 * limits output; a `usd` account the door cannot price never lets a call
 * through.
 */
function outputAllowance(
  unit: SpendUnit,
  available: number,
  inputTokens: number,
  rates: WorstRates,
): number | null {
  switch (unit) {
    case "input_tokens":
      return inputTokens > available ? null : Number.POSITIVE_INFINITY;
    case "output_tokens":
      return Math.floor(available);
    case "usd": {
      if (!rates) return null;
      const afterInput = available - inputTokens * rates.input;
      if (afterInput < 0) return null;
      return rates.output > 0 ? Math.floor(afterInput / rates.output) : Number.POSITIVE_INFINITY;
    }
  }
}

/** A call's worst case in `unit`: its projected input and its clamped output. */
function projectedCost(
  unit: SpendUnit,
  inputTokens: number,
  outputTokens: number,
  rates: WorstRates,
): number {
  switch (unit) {
    case "input_tokens":
      return inputTokens;
    case "output_tokens":
      return outputTokens;
    case "usd":
      // Reached only after `outputAllowance` let the call through, so priced.
      return rates ? inputTokens * rates.input + outputTokens * rates.output : 0;
  }
}

interface Live {
  unit: SpendUnit;
  balance: number;
  /** Outstanding reservations of every call in flight against this id. */
  reserved: number;
  holders: number;
}

/** Create the per-process store of live balances. */
export function createSpendBalances(): SpendBalances {
  const live = new Map<string, Live>();

  return {
    open(accounts, pricing) {
      // One entry per id, even if a run names an id twice.
      const ids: string[] = [];
      for (const account of accounts) {
        if (ids.includes(account.id)) continue;
        ids.push(account.id);
        const entry = live.get(account.id);
        if (entry) entry.holders++;
        else {
          live.set(account.id, {
            unit: account.unit,
            balance: account.remaining,
            reserved: 0,
            holders: 1,
          });
        }
      }
      const rates = pricing.rates ? worstRates(pricing.rates) : null;
      // This run's outstanding reservation per id: one call's, from `check`
      // until its `debit`.
      const reservation = new Map<string, number>();
      const unreserve = () => {
        for (const [id, amount] of reservation) live.get(id)!.reserved -= amount;
        reservation.clear();
      };
      let released = false;

      return {
        check(call) {
          // A check replaces any reservation this run still holds, so a call
          // that never reached its debit cannot keep its worst case reserved.
          unreserve();
          const floor = Math.min(call.minOutputTokens, call.maxOutputTokens);
          let allowed = call.maxOutputTokens;
          for (const id of ids) {
            const entry = live.get(id)!;
            const allowance = outputAllowance(
              entry.unit,
              entry.balance - entry.reserved,
              call.inputTokens,
              rates,
            );
            if (allowance === null) return { accountId: id };
            allowed = Math.min(allowed, allowance);
            if (allowed < floor) return { accountId: id };
          }
          for (const id of ids) {
            const entry = live.get(id)!;
            const amount = projectedCost(entry.unit, call.inputTokens, allowed, rates);
            entry.reserved += amount;
            reservation.set(id, amount);
          }
          return { maxOutputTokens: allowed };
        },
        debit(actual) {
          unreserve();
          for (const id of ids) {
            const entry = live.get(id)!;
            entry.balance -= spendIn(entry.unit, actual, pricing);
          }
        },
        release() {
          if (released) return;
          released = true;
          unreserve();
          for (const id of ids) {
            const entry = live.get(id)!;
            if (--entry.holders === 0) live.delete(id);
          }
        },
      };
    },
    balance: (id) => live.get(id)?.balance,
  };
}
