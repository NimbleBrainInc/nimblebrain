/**
 * Which providers the installation's model gateway serves, asked of the gateway
 * itself (`GET <gateway>/providers`), so the runtime holds no provider list of
 * its own when it has a gateway. The gateway holds the keys; which providers it
 * can reach is its answer, generated from its own config.
 *
 * - The list changes only when the gateway is redeployed, so it is asked once,
 *   when the runtime starts, and again only until it answers: each failure
 *   retries after twice the last wait, up to `RETRY_MAX_MS`.
 * - Until it answers, `served()` is `undefined` and the runtime treats every
 *   provider it knows as served, so the gateway being slow or down at boot
 *   never blocks the boot or empties the model list. A model the gateway does
 *   not serve then fails when it is called, as it would without discovery; the
 *   gateway is what enforces reachability either way.
 * - The call goes through the gateway's fetch, so it carries a single-use model
 *   credential like any call outside a run.
 */

import { MODEL_PROVIDERS, type ModelGatewayAccess } from "../model/registry.ts";
import { log } from "../observability/log.ts";

const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

export interface GatewayProviders {
  /** The providers the gateway serves, or `undefined` until it has answered. */
  served(): readonly string[] | undefined;
  /** Stop asking (the runtime is shutting down). */
  stop(): void;
}

export function watchGatewayProviders(
  gateway: ModelGatewayAccess,
  opts: { retryInitialMs?: number; retryMaxMs?: number } = {},
): GatewayProviders {
  const url = `${gateway.url.replace(/\/+$/, "")}/providers`;
  let served: readonly string[] | undefined;
  let lastReason: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let wait = opts.retryInitialMs ?? RETRY_INITIAL_MS;
  const maxWait = opts.retryMaxMs ?? RETRY_MAX_MS;

  const ask = async (): Promise<void> => {
    try {
      served = parseProviders(await fetchProviders(gateway.fetch, url));
      log.info("[model-gateway] providers served", { providers: served.join(",") });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Logged when the reason changes, not on every retry.
      if (lastReason !== reason) {
        log.warn(
          "[model-gateway] could not learn the served providers; offering every provider until it answers",
          {
            error: reason,
            retry_ms: wait,
          },
        );
      }
      lastReason = reason;
      if (stopped) return;
      timer = setTimeout(() => void ask(), wait);
      timer.unref?.();
      wait = Math.min(wait * 2, maxWait);
    }
  };
  void ask();

  return {
    served: () => served,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function fetchProviders(fetch: typeof globalThis.fetch, url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET /providers answered ${res.status}`);
  return res.json();
}

/**
 * The gateway's answer, `{"providers": [<name>, …]}`, kept to the providers the
 * runtime can build. A name it does not know is logged and left out: the
 * runtime has no client for it.
 */
function parseProviders(body: unknown): readonly string[] {
  const names = (body as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new Error("GET /providers answered without a providers list");
  }
  const known = new Set<string>(MODEL_PROVIDERS);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    log.warn("[model-gateway] the gateway serves providers the runtime cannot build", {
      providers: unknown.join(","),
    });
  }
  return names.filter((n) => known.has(n));
}
