import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * The model control in the composer's action row.
 *
 * A conversation is bound to one model when it is created and keeps it for
 * life, so this control has two states and the difference between them is the
 * whole point:
 *
 * - **Before the first message** it is a picker. What you choose becomes the
 *   binding.
 * - **After** it is the same words in the same place, and its menu offers the
 *   only thing that can actually change the model — a new conversation.
 *
 * A control that simply stopped working would read as broken. One that answers
 * the question and offers the real next step stays useful without pretending
 * the binding can move.
 */

export interface PickerModel {
  /** Qualified `provider:model-id` — what goes on the wire and into the pin. */
  id: string;
  /** Catalog name, e.g. "Claude Sonnet 5". */
  name: string;
  provider: string;
}

/**
 * Short form for the button. A vendor word the product already implies is
 * noise in a row this tight; every other vendor's name carries information
 * ("GPT-4.1", "Gemini 3 Flash") and is left alone.
 */
export function shortModelName(name: string): string {
  return name.replace(/^Claude\s+/, "");
}

/** Everything the deployment offers, flattened and sorted for one list. */
export function toPickerModels(
  available: Record<string, { id: string; name?: string }[]> | undefined,
): PickerModel[] {
  if (!available) return [];
  return Object.entries(available)
    .flatMap(([provider, models]) =>
      models.map((m) => ({ id: `${provider}:${m.id}`, name: m.name ?? m.id, provider })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function matches(m: PickerModel, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q);
}

export function ModelPicker({
  models,
  selected,
  bound,
  onSelect,
  onNewConversation,
  disabled,
}: {
  models: PickerModel[];
  /** The model a message sent now would use. */
  selected: string | undefined;
  /** Set once the conversation exists — the binding, which cannot change. */
  bound?: string;
  onSelect: (id: string) => void;
  /** Start a fresh conversation on the given model. */
  onNewConversation?: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // A model id carries `:` and `.`, neither of which is legal unescaped in the
  // id an aria-activedescendant lookup resolves.
  const optionId = (modelId: string) => `${listId}-${modelId.replace(/[^\w-]/g, "_")}`;

  const current = bound ?? selected;
  const label = useMemo(() => {
    const hit = models.find((m) => m.id === current);
    // A conversation can be bound to something the deployment no longer
    // offers — a narrowed policy, a retired model. Show what it is rather
    // than falling back to a name that would be wrong.
    return hit ? shortModelName(hit.name) : (current ?? "Model");
  }, [models, current]);

  const hits = useMemo(() => models.filter((m) => matches(m, query)), [models, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Focus lands in the field: with a handful of models nobody touches it,
    // and with a long list you are already typing.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = useCallback(
    (m: PickerModel) => {
      if (bound) onNewConversation?.(m.id);
      else onSelect(m.id);
      setOpen(false);
    },
    [bound, onNewConversation, onSelect],
  );

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = hits[active];
      if (m) choose(m);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={current}
        className="flex items-center gap-1 max-w-[11rem] px-1.5 py-1 rounded-sm text-xs text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[0.5rem] opacity-60">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-1 z-50 w-72 rounded-sm border bg-popover text-popover-foreground shadow-md overflow-hidden">
          {bound ? (
            <p className="px-3 pt-2 pb-1 text-3xs text-muted-foreground">
              This conversation uses <span className="text-foreground">{label}</span>. Start a new
              one with:
            </p>
          ) : (
            <div className="border-b p-2">
              {/* The keys are handled here rather than on the popup because
                  this is where focus is; the highlight travels as
                  aria-activedescendant so the caret never leaves the field. */}
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search models"
                aria-label="Search models"
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={hits[active] ? optionId(hits[active].id) : undefined}
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}

          {hits.length === 0 ? (
            <p className="px-2 py-3 text-center text-3xs text-muted-foreground">
              No model matches “{query}”
            </p>
          ) : (
            <div
              id={listId}
              role="listbox"
              aria-label="Models"
              className="max-h-64 overflow-y-auto p-1"
            >
              {hits.map((m, i) => {
                const isCurrent = m.id === current;
                return (
                  <button
                    key={m.id}
                    id={optionId(m.id)}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(m)}
                    className={`w-full text-left px-2 py-1.5 rounded-sm flex items-baseline justify-between gap-2 ${
                      i === active ? "bg-muted" : ""
                    }`}
                  >
                    <span className="text-xs truncate">{shortModelName(m.name)}</span>
                    {isCurrent && !bound && <span className="text-3xs text-primary">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
