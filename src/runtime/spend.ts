/**
 * Spend accounts: what a run may spend, checked before each model call and
 * debited after it.
 *
 * Asserted at the run-start door (`Runtime.startRun`), so every source that
 * starts runs inherits it (ADR-0045). A run's description names a list of
 * accounts, each an opaque id the source chose, with a unit and the amount
 * remaining. The door keeps ONE live balance per id for as long as any run
 * naming it is in flight: the first run to name an id sets its unit and
 * balance, and every later run naming it checks and debits that same balance,
 * so runs sharing an account cannot together exceed it. The balance is
 * discarded when the last run naming the id ends; the source re-issues the
 * remaining amount on its next run, from the debits it was told about.
 *
 * The door never interprets an id. Whether one stands for a batch, a task, or
 * a workspace is the source's knowledge, so nothing here branches on it.
 */

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

/** What one model call took from one account. */
export interface SpendDebit {
  accountId: string;
  unit: SpendUnit;
  amount: number;
  /** The account's balance after this debit. Negative when the call overran its projection. */
  remaining: number;
}

/**
 * How a model call is costed in each unit. `usd` prices with the run model's
 * rates, the same arithmetic as `costBreakdown`.
 */
export interface SpendPricing {
  rates: UsageRates | null;
  model: string;
}

/** The accounts one run holds open. */
export interface SpendHold {
  /**
   * The first account the projected call would take past its balance, or null
   * when every account can pay for it.
   */
  check(projected: TokenUsage): string | null;
  /** Debit every account with a call's actual usage; returns what each paid. */
  debit(actual: TokenUsage): SpendDebit[];
  /** Stop holding the accounts. The last run to release an id discards its balance. Idempotent. */
  release(): void;
}

export interface SpendBalances {
  /** Hold `accounts` open for one run. */
  open(accounts: readonly SpendAccount[], pricing: SpendPricing): SpendHold;
  /** The live balance of `id`, or undefined when no run in flight names it. */
  balance(id: string): number | undefined;
}

/**
 * The cost of `usage` in `unit`.
 *
 * A `usd` amount on a model with no known rates is `Infinity` when projecting,
 * so an account the door cannot price never lets a call through, and 0 when
 * debiting, since nothing is known to have been charged.
 */
export function spendIn(
  unit: SpendUnit,
  usage: TokenUsage,
  pricing: SpendPricing,
  mode: "project" | "debit",
): number {
  switch (unit) {
    case "input_tokens":
      return usage.inputTokens;
    case "output_tokens":
      return usage.outputTokens;
    case "usd":
      if (!pricing.rates) return mode === "project" ? Number.POSITIVE_INFINITY : 0;
      return costBreakdown(pricing.model, usage, pricing.rates).total;
  }
}

interface Live {
  unit: SpendUnit;
  balance: number;
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
        else live.set(account.id, { unit: account.unit, balance: account.remaining, holders: 1 });
      }
      let released = false;
      return {
        check(projected) {
          for (const id of ids) {
            const entry = live.get(id)!;
            if (spendIn(entry.unit, projected, pricing, "project") > entry.balance) return id;
          }
          return null;
        },
        debit(actual) {
          return ids.map((id) => {
            const entry = live.get(id)!;
            const amount = spendIn(entry.unit, actual, pricing, "debit");
            entry.balance -= amount;
            return { accountId: id, unit: entry.unit, amount, remaining: entry.balance };
          });
        },
        release() {
          if (released) return;
          released = true;
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
