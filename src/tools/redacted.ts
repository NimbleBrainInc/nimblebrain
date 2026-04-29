/**
 * Wrapper for sensitive values that must never appear in logs, error
 * messages, or serialized output. Overrides every common stringification
 * path — `toString`, `toJSON`, and Bun/Node's util.inspect symbol — so a
 * value that escapes into a `console.log`, `JSON.stringify`, or template
 * literal renders as `"[redacted]"`.
 *
 * Usage:
 *
 *   const token = new Redacted("eyJhbG...");
 *   console.log(token);            // [redacted]
 *   `bearer ${token}`              // bearer [redacted]
 *   JSON.stringify({ token })      // {"token":"[redacted]"}
 *   token.reveal()                 // "eyJhbG..."   (explicit opt-in)
 *
 * The value is held in a private field; `reveal()` is the only path that
 * returns it. Code that needs to actually use the secret (HTTP header,
 * token exchange) calls `.reveal()` at the boundary; everywhere else
 * holds the wrapper.
 *
 * Equality: `Redacted` is a value-type wrapper, not deduped. Two
 * instances wrapping the same string are NOT `===`. Compare via
 * `.reveal()` if you really need that — and prefer not to.
 */
export class Redacted<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Return the wrapped value. The only sanctioned path out of redaction. */
  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  /** Bun and Node both honor this symbol from `util.inspect` (and console.log). */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/** Type guard. */
export function isRedacted(v: unknown): v is Redacted<unknown> {
  return v instanceof Redacted;
}
