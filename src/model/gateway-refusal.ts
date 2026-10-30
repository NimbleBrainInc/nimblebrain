/**
 * The model gateway's refusal of a call because the run's model budget is
 * spent (ADR-0057: the gateway is the only model endpoint an installation's
 * agents call, and it caps each run's tokens).
 *
 * The gateway (agentgateway) caps a run with a token-bucket rate limit keyed on
 * the run, and answers a call past it as it answers any rate limit of its own:
 * 429, `text/plain`, body `rate limit exceeded`. No provider answers in that
 * form (a provider's 429 is its own JSON error, which the gateway passes
 * through), and the run budget is the gateway's only rate limit, so on a call
 * that went to the installation's gateway that answer means the run's budget is
 * spent. A rate limit added to the gateway would answer the same way, and must
 * then be told apart here. The `x-ratelimit-*` headers do not tell them apart:
 * the gateway sets them on admitted calls too, a provider's 429 included.
 *
 * Trust it only for a call that went to the installation's gateway: any other
 * endpoint may send the same words for a limit that clears on retry.
 */

/** The body of the gateway's answer to a call past one of its rate limits. */
const REFUSAL_BODY = "rate limit exceeded";

const TOO_MANY_REQUESTS = 429;

/**
 * The spend account a run stopped by the gateway's budget names
 * (`EngineResult.spendAccountId` with stopReason `spend_limit`). The runtime
 * holds no balance for it: the gateway does.
 */
export const MODEL_GATEWAY_BUDGET_ACCOUNT = "model-gateway:run";

/** Whether a gateway response's status and content type could be its budget refusal. */
export function mayBeGatewayBudgetRefusal(status: number, contentType: string | null): boolean {
  return status === TOO_MANY_REQUESTS && (contentType ?? "").startsWith("text/plain");
}

/** Whether the gateway's answer to a call is its refusal for a spent run budget. */
export function isGatewayBudgetRefusal(status: number, body: string | undefined): boolean {
  return status === TOO_MANY_REQUESTS && body?.trim() === REFUSAL_BODY;
}

const NAME = "ModelBudgetSpentError";

/**
 * A call the gateway refused because the run's model budget is spent. Retrying
 * cannot help (the budget does not refill within a run), so it is marked
 * `retryable: false`, which `withRetry` honours ahead of the status, and the
 * engine ends the run with stopReason `spend_limit`.
 */
export class ModelBudgetSpentError extends Error {
  override readonly name = NAME;
  readonly retryable = false;
  constructor() {
    super("This run's model budget is spent: the model gateway refused its next call.");
  }
}

/**
 * Whether `err` is the gateway's refusal for a spent run budget. Read by name,
 * so a second copy of this module in a bundle still recognises it.
 */
export function isModelBudgetSpent(err: unknown): boolean {
  return err instanceof Error && err.name === NAME;
}
