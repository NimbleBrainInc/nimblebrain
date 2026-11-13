/**
 * Which providers the installation's model gateway serves, asked of the gateway
 * itself (`GET <gateway>/providers`), so the runtime holds no provider list of
 * its own when it has a gateway. The gateway holds the keys; which providers it
 * can reach is its answer, generated from its own config.
 *
 * - The answer changes when the gateway is redeployed, which the runtime does not
 *   see, so it is asked when the runtime starts and again every `REFRESH_MS`. A
 *   failed ask retries after twice the last wait, up to `RETRY_MAX_MS`, and an
 *   answer already given stands until a new one replaces it: a gateway that is
 *   briefly unreachable has not changed what it serves or enforces.
 * - Until it answers, `served()` is `undefined` and the runtime treats every
 *   provider it knows as served, so the gateway being slow or down at boot
 *   never blocks the boot or empties the model list. A model the gateway does
 *   not serve then fails when it is called, as it would without discovery; the
 *   gateway is what enforces reachability either way.
 * - The call goes through the gateway's fetch, so it carries a single-use model
 *   credential like any call outside a run.
 * - The same answer says whether the gateway holds a run to the grant its
 *   credential carries (`"grants": true`, ADR-0063). Until it answers, and when
 *   it says nothing, it does not: an external runtime then holds no run with
 *   spend accounts or a cap, so a gateway that would ignore the grant never
 *   runs budgeted work.
 */

import { MODEL_PROVIDERS, type ModelGatewayAccess } from "../model/registry.ts";
import { log } from "../observability/log.ts";

const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const REFRESH_MS = 60_000;

export interface GatewayProviders {
  /** The providers the gateway serves, or `undefined` until it has answered. */
  served(): readonly string[] | undefined;
  /** Whether the gateway said it enforces a credential's grant; false until it answers. */
  enforcesGrants(): boolean;
  /** Stop asking (the runtime is shutting down). */
  stop(): void;
}

export function watchGatewayProviders(
  gateway: ModelGatewayAccess,
  opts: { retryInitialMs?: number; retryMaxMs?: number; refreshMs?: number } = {},
): GatewayProviders {
  const url = `${gateway.url.replace(/\/+$/, "")}/providers`;
  let served: readonly string[] | undefined;
  let grants = false;
  let lastReason: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const initialWait = opts.retryInitialMs ?? RETRY_INITIAL_MS;
  let wait = initialWait;
  const maxWait = opts.retryMaxMs ?? RETRY_MAX_MS;
  const refresh = opts.refreshMs ?? REFRESH_MS;

  const askAgainIn = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void ask(), ms);
    timer.unref?.();
  };

  const ask = async (): Promise<void> => {
    try {
      const body = await fetchProviders(gateway.fetch, url);
      const nextServed = parseProviders(body);
      const nextGrants = (body as { grants?: unknown } | null)?.grants === true;
      // Logged when the answer changes, not on every refresh.
      if (served?.join(",") !== nextServed.join(",") || grants !== nextGrants) {
        log.info("[model-gateway] providers served", {
          providers: nextServed.join(","),
          enforces_grants: nextGrants,
        });
      }
      served = nextServed;
      grants = nextGrants;
      lastReason = undefined;
      wait = initialWait;
      askAgainIn(refresh);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Logged when the reason changes, not on every retry.
      if (lastReason !== reason) {
        log.warn(
          served === undefined
            ? "[model-gateway] could not learn the served providers; offering every provider until it answers"
            : "[model-gateway] could not ask the gateway again; keeping its last answer",
          { error: reason, retry_ms: wait },
        );
      }
      lastReason = reason;
      askAgainIn(wait);
      wait = Math.min(wait * 2, maxWait);
    }
  };
  void ask();

  return {
    served: () => served,
    enforcesGrants: () => grants,
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
