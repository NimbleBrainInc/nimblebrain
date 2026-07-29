/**
 * Run `worker` over `items` with at most `concurrency` in flight. Preserves
 * per-item index so callers can write results into a pre-sized array without
 * worrying about completion order. Errors thrown by `worker` propagate — this
 * helper does not swallow them; the caller is responsible for per-item
 * try/catch when continue-on-failure is desired.
 *
 * Scope intentionally narrow — this is not a general-purpose `p-limit`
 * replacement; it's shaped for bounded fan-out over a fixed list. It lives in
 * `util/` rather than beside either caller because both the boot loop
 * (`workspace-runtime`) and the engine's per-source tool dispatch need it, and
 * the engine must not import from `runtime/`.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx] as T;
      await worker(item, idx);
    }
  });
  await Promise.all(runners);
}
