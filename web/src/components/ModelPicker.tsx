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

/** A dated snapshot id, e.g. `claude-opus-4-5-20251101`. */
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * One row per model a person would name.
 *
 * The catalog lists some models twice — an undated id and a dated snapshot of
 * it (`claude-opus-4-5` and `claude-opus-4-5-20251101`), identical in cost,
 * limits and capabilities. Operator surfaces offer both on purpose, because
 * pinning a fixed snapshot is a real deployment choice. Someone picking a model
 * for one chat is answering a different question, and to them the pair reads as
 * the list being broken.
 *
 * Of the pair, the undated id is kept: it exists for every model (dated
 * variants only exist for some) and it is the form the operator config already
 * writes, so a pin made here looks like a slot set there. The dated sibling's
 * *name* is kept instead of the alias's, because the alias is named
 * "Claude Opus 4.5 (latest)" — a suffix that means "newest 4.5 snapshot" but
 * reads as "newest Opus", which is false the moment Opus 5 ships. With the pair
 * collapsed the suffix distinguishes nothing anyway.
 *
 * A "(latest)" model with no dated sibling — `gpt-5.3-chat-latest` — is left
 * alone: there the moving pointer is the whole model, not one name for two.
 */
export function toPickerModels(
  available: Record<string, { id: string; name?: string }[]> | undefined,
): PickerModel[] {
  if (!available) return [];
  return Object.entries(available)
    .flatMap(([provider, models]) => {
      const offered = new Set(models.map((m) => m.id));
      // A snapshot is a duplicate only when its own undated id is also on
      // offer; alone, it is the only way to name that model.
      const duplicates = (m: { id: string }) =>
        DATED_SNAPSHOT.test(m.id) && offered.has(m.id.replace(DATED_SNAPSHOT, ""));

      const nameFromSnapshot = new Map<string, string>();
      for (const m of models) {
        if (duplicates(m) && m.name) nameFromSnapshot.set(m.id.replace(DATED_SNAPSHOT, ""), m.name);
      }

      return models
        .filter((m) => !duplicates(m))
        .map((m) => ({
          id: `${provider}:${m.id}`,
          name: nameFromSnapshot.get(m.id) ?? m.name ?? m.id,
          provider,
        }));
    })
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
        // Rests muted and comes up to full contrast on hover, which is the
        // idiom of the two buttons beside it. `bg-muted` on this ground is a
        // few percent of luminance; the text step is what actually reads as
        // "this responds". Staying lit while open keeps the menu anchored to
        // the thing that opened it.
        className={`flex items-center gap-1 max-w-[11rem] px-1.5 py-1 rounded-sm text-xs cursor-pointer hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50 transition-colors ${
          open ? "bg-muted text-foreground" : "text-muted-foreground"
        }`}
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
                    // Nothing is selected in the bound list: every row there
                    // starts a new conversation rather than marking this one.
                    aria-selected={isCurrent && !bound}
                    // Movement, not entry: filtering the list slides rows under
                    // a cursor that never moved, and `mouseenter` would let
                    // that steal the highlight from the keyboard.
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(m)}
                    className={`w-full text-left px-2 py-1.5 rounded-sm cursor-pointer flex items-baseline justify-between gap-2 ${
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
