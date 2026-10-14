/**
 * Typed per-browser preferences in `localStorage`.
 *
 * A preference here is a viewer's convenience, not workspace state: it is never
 * sent to the server, differs per browser, and losing it only restores the
 * default. `localStorage` is readable by any script on the origin, so nothing
 * secret belongs in one.
 *
 * Every read goes through the preference's `parse`, which turns whatever is
 * stored (junk, an older shape, another tab's write) into a valid value or the
 * `empty` one, so a bad entry never reaches a component. Storing the `empty`
 * value removes the key.
 *
 * One store per key backs every surface: a write re-renders every reader in
 * this tab at once, and a `storage` event carries it to the viewer's other tabs.
 */

import { useCallback, useSyncExternalStore } from "react";

export interface LocalPref<T> {
  /** The `localStorage` key, `nb:`-prefixed. A per-workspace preference puts the id in it. */
  key: string;
  /** Turn the parsed JSON into a valid value; return `empty` for anything unusable. */
  parse: (stored: unknown) => T;
  /** The default, shown when nothing usable is stored. */
  empty: T;
}

const listeners = new Map<string, Set<() => void>>();
// useSyncExternalStore needs a stable snapshot between changes, so each key's
// parsed value is cached and replaced only when the stored string changes.
const cache = new Map<string, { raw: string | null; value: unknown }>();

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts.
    return null;
  }
}

function parseRaw<T>(pref: LocalPref<T>, raw: string | null): T {
  if (raw === null) return pref.empty;
  try {
    return pref.parse(JSON.parse(raw));
  } catch {
    return pref.empty;
  }
}

export function readPref<T>(pref: LocalPref<T>): T {
  const raw = readRaw(pref.key);
  const hit = cache.get(pref.key);
  if (hit && hit.raw === raw) return hit.value as T;
  const value = parseRaw(pref, raw);
  cache.set(pref.key, { raw, value });
  return value;
}

export function writePref<T>(pref: LocalPref<T>, value: T): void {
  const raw = JSON.stringify(value);
  try {
    if (raw === JSON.stringify(pref.empty)) localStorage.removeItem(pref.key);
    else localStorage.setItem(pref.key, raw);
  } catch {
    // Best-effort: a preference that does not persist only restores the default.
  }
  for (const l of listeners.get(pref.key) ?? []) l();
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, set);
  set.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference's current value, re-rendering when it changes in this tab or another. */
export function usePref<T>(pref: LocalPref<T>): T {
  const { key } = pref;
  const sub = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  return useSyncExternalStore(
    sub,
    () => readPref(pref),
    () => pref.empty,
  );
}

/** `parse` for a list of strings: keeps the strings, drops duplicates and anything else. */
export function parseStringList(stored: unknown): readonly string[] {
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter((v): v is string => typeof v === "string"))];
}

/** Add `item` to the end of a list preference, or remove it if present. */
export function toggleListItem(pref: LocalPref<readonly string[]>, item: string): void {
  const current = readPref(pref);
  writePref(pref, current.includes(item) ? current.filter((v) => v !== item) : [...current, item]);
}
