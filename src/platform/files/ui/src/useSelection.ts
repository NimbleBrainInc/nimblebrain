import { useCallback, useEffect, useState } from "react";

/**
 * Selected rows, by id. Shift extends from the last row toggled. `resetKey`
 * names the rows the selection was made on; a new key clears it.
 */
export function useSelection(rowIds: string[], resetKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [resetKey]);

  const toggle = useCallback(
    (id: string, range: boolean) => {
      setSelected((prev) => {
        const from = anchor ? rowIds.indexOf(anchor) : -1;
        if (range && from >= 0) {
          const to = rowIds.indexOf(id);
          const [a, b] = from < to ? [from, to] : [to, from];
          return new Set([...prev, ...rowIds.slice(a, b + 1)]);
        }
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
    },
    [anchor, rowIds],
  );

  const toggleAll = useCallback(() => {
    setSelected((prev) => (prev.size === rowIds.length ? new Set() : new Set(rowIds)));
  }, [rowIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return { selected, toggle, toggleAll, clear };
}
