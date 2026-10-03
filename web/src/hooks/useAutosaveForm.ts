import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNotice } from "../components/notices";

/**
 * A form whose fields save themselves, one at a time, as they change.
 *
 * Each field holds a draft and the value last saved. A field is committed —
 * sent through `save` — when the edit is complete: a select on change, a text
 * field on blur or Enter. Escape reverts a text field to its saved value.
 *
 * Saves run one at a time, in the order they were committed, so two writes
 * never race to the server. A field committed again while its save is queued
 * is not queued twice: the queued save sends the latest draft when its turn
 * comes. A save touches one field only, so it never overwrites another field
 * being edited, and the form never has to lock.
 *
 * A failed save keeps the draft and marks the field, so nothing typed is lost;
 * the field offers Retry and Revert.
 */

export type FieldStatus = "clean" | "dirty" | "saving" | "saved" | "error";

/** The page-level summary, for the line under the page title. */
export type FormStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * Where a field reports its saves. The field itself always shows its status;
 * this adds a notice (`components/notices.tsx`) on top.
 */
export interface AutosaveNoticePolicy {
  /** Raise a notice when the field saves. */
  success: "field" | "notice";
  /** Raise a notice when a save fails. */
  error: "field" | "notice";
  /** Put Undo on the success notice. Implies `success: "notice"`. */
  undo: boolean;
}

const FIELD_ONLY: AutosaveNoticePolicy = { success: "field", error: "field", undo: false };

/** How long a field shows "Saved" before settling back to clean. */
const SAVED_FLASH_MS = 1500;

export interface AutosaveOptions<V> {
  /** Persist one field. Reject with an `Error` whose message the field shows. */
  save: <K extends keyof V>(field: K, value: V[K]) => Promise<void>;
  /** Called after a field saves, with the value it replaced. */
  onSaved?: <K extends keyof V>(field: K, value: V[K], previous: V[K]) => void;
  /** Each field's label, for notices. */
  labels: Record<keyof V, string>;
  /** Per-field notice policy. A field not listed reports on the field only. */
  notices?: Partial<Record<keyof V, Partial<AutosaveNoticePolicy>>>;
}

type StringKeys<V> = { [K in keyof V]: V[K] extends string ? K : never }[keyof V];

export function useAutosaveForm<V extends object>(initial: V, options: AutosaveOptions<V>) {
  const notify = useNotice();
  const [draft, setDraftState] = useState<V>(initial);
  const [statuses, setStatuses] = useState<Partial<Record<keyof V, FieldStatus>>>({});
  const [errors, setErrors] = useState<Partial<Record<keyof V, string>>>({});
  const [everSaved, setEverSaved] = useState(false);

  // The async save path reads these, not render-time state, so a save that
  // finishes after further edits sees the edits.
  const draftRef = useRef<V>(initial);
  const savedRef = useRef<V>(initial);
  const statusRef = useRef<Partial<Record<keyof V, FieldStatus>>>({});
  const queued = useRef(new Set<keyof V>());
  // Fields whose next save is an Undo. That save reports on the field only: a
  // notice for it would offer Undo of the Undo.
  const undoing = useRef(new Set<keyof V>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timers = useRef(new Map<keyof V, ReturnType<typeof setTimeout>>());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Undo raises `commit` from a notice created by an earlier render.
  const commitRef = useRef<(field: keyof V, value?: V[keyof V]) => void>(() => {});

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const setStatus = useCallback((field: keyof V, status: FieldStatus) => {
    const timer = timers.current.get(field);
    if (timer) clearTimeout(timer);
    timers.current.delete(field);
    statusRef.current = { ...statusRef.current, [field]: status };
    setStatuses(statusRef.current);
    if (status === "saved") {
      timers.current.set(
        field,
        setTimeout(() => {
          if (statusRef.current[field] === "saved") setStatus(field, "clean");
        }, SAVED_FLASH_MS),
      );
    }
  }, []);

  const setError = useCallback((field: keyof V, message: string | null) => {
    setErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[field];
      else next[field] = message;
      return next;
    });
  }, []);

  /** Replace every field's draft and saved value, as on first load. */
  const load = useCallback((values: V) => {
    draftRef.current = values;
    savedRef.current = values;
    statusRef.current = {};
    setDraftState(values);
    setStatuses({});
    setErrors({});
  }, []);

  /** Change a field's draft without saving it. */
  const set = useCallback(
    <K extends keyof V>(field: K, value: V[K]) => {
      draftRef.current = { ...draftRef.current, [field]: value };
      setDraftState(draftRef.current);
      // A queued or running save reads the draft when it runs, and settles the
      // status itself.
      if (statusRef.current[field] === "saving") return;
      // Editing a field that failed starts a new attempt; the old error no
      // longer describes what the field holds.
      setError(field, null);
      setStatus(field, Object.is(value, savedRef.current[field]) ? "clean" : "dirty");
    },
    [setError, setStatus],
  );

  /** A save failed: keep the draft, mark the field, and raise a notice if the policy asks. */
  const failed = useCallback(
    (field: keyof V, err: unknown, isUndo: boolean) => {
      const opts = optionsRef.current;
      const message = err instanceof Error ? err.message : "The change was not saved.";
      setError(field, message);
      if (!queued.current.has(field)) setStatus(field, "error");
      const policy = { ...FIELD_ONLY, ...opts.notices?.[field] };
      // A failed Undo always says so: the reader acted on a notice, and the
      // field may be scrolled out of view.
      if (policy.error !== "notice" && !isUndo) return;
      const label = opts.labels[field];
      const title = isUndo ? `Couldn't undo the change to ${label}` : `Couldn't save ${label}`;
      notify({ level: "error", title, description: message });
    },
    [notify, setError, setStatus],
  );

  /** A save landed: record it, settle the field, and raise a notice if the policy asks. */
  const landed = useCallback(
    (field: keyof V, value: V[keyof V], previous: V[keyof V], isUndo: boolean) => {
      const opts = optionsRef.current;
      savedRef.current = { ...savedRef.current, [field]: value };
      setEverSaved(true);
      setError(field, null);
      if (!queued.current.has(field)) {
        setStatus(field, Object.is(draftRef.current[field], value) ? "saved" : "dirty");
      }
      opts.onSaved?.(field, value, previous);
      // The save an Undo makes raises no notice: it would offer Undo of the Undo.
      if (isUndo) return;
      const policy = { ...FIELD_ONLY, ...opts.notices?.[field] };
      const title = `${opts.labels[field]} updated`;
      if (policy.undo) {
        const undo = () => {
          // Already back at that value (reverted by hand since): nothing to save.
          if (Object.is(savedRef.current[field], previous)) return;
          undoing.current.add(field);
          commitRef.current(field, previous);
        };
        notify({ level: "success", title, action: { label: "Undo", onClick: undo } });
      } else if (policy.success === "notice") {
        notify({ level: "success", title });
      }
    },
    [notify, setError, setStatus],
  );

  const run = useCallback(
    async (field: keyof V) => {
      queued.current.delete(field);
      const isUndo = undoing.current.delete(field);
      const value = draftRef.current[field];
      const previous = savedRef.current[field];
      if (Object.is(value, previous)) {
        setError(field, null);
        setStatus(field, "clean");
        return;
      }
      try {
        await optionsRef.current.save(field, value);
      } catch (err) {
        failed(field, err, isUndo);
        return;
      }
      landed(field, value, previous, isUndo);
    },
    [failed, landed, setError, setStatus],
  );

  /** Save a field's draft, after optionally setting it. A no-op when it matches what is saved. */
  const commit = useCallback(
    <K extends keyof V>(field: K, value?: V[K]) => {
      if (value !== undefined) {
        draftRef.current = { ...draftRef.current, [field]: value };
        setDraftState(draftRef.current);
      }
      if (queued.current.has(field)) return;
      if (Object.is(draftRef.current[field], savedRef.current[field])) {
        if (statusRef.current[field] !== "saving") {
          setError(field, null);
          setStatus(field, "clean");
        }
        return;
      }
      queued.current.add(field);
      setStatus(field, "saving");
      chain.current = chain.current.then(() => run(field));
    },
    [run, setError, setStatus],
  );
  commitRef.current = commit;

  /** Put a field back to its saved value and drop its error. */
  const revert = useCallback(
    (field: keyof V) => {
      draftRef.current = { ...draftRef.current, [field]: savedRef.current[field] };
      setDraftState(draftRef.current);
      setError(field, null);
      if (statusRef.current[field] !== "saving") setStatus(field, "clean");
    },
    [setError, setStatus],
  );

  const all = Object.values(statuses) as FieldStatus[];
  const status: FormStatus = all.includes("error")
    ? "error"
    : all.includes("saving")
      ? "saving"
      : all.includes("dirty")
        ? "dirty"
        : everSaved
          ? "saved"
          : "idle";

  // Leaving with a save in flight, or an edit not yet committed, loses it.
  const unsaved = status === "saving" || status === "dirty" || status === "error";
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  /** Bindings for a text or number `<input>`: commit on blur and Enter, revert on Escape. */
  const inputProps = <K extends StringKeys<V>>(field: K) => ({
    value: draft[field] as string,
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(field, e.target.value as V[K]),
    onBlur: () => commit(field),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") commit(field);
      if (e.key === "Escape") revert(field);
    },
    "aria-invalid": statuses[field] === "error" || undefined,
  });

  /** Bindings for a `<select>`: a choice is a complete edit, so it commits at once. */
  const selectProps = <K extends StringKeys<V>>(field: K) => ({
    value: draft[field] as string,
    onChange: (e: ChangeEvent<HTMLSelectElement>) => commit(field, e.target.value as V[K]),
    "aria-invalid": statuses[field] === "error" || undefined,
  });

  /** Everything `AutosaveField` needs to show a field's state. */
  const fieldState = (field: keyof V) => ({
    status: statuses[field] ?? ("clean" as FieldStatus),
    error: errors[field] ?? null,
    onRetry: () => commit(field),
    onRevert: () => revert(field),
  });

  return {
    values: draft,
    status,
    load,
    set,
    commit,
    revert,
    inputProps,
    selectProps,
    fieldState,
  };
}
