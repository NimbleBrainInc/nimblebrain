import { happyDomWindow } from "./setup";

/**
 * Defines `window.SyntaxError` and `window.TypeError` from the runtime's own
 * classes when the test window lacks them.
 *
 * happy-dom builds its selector-parse errors from those two, and its Window
 * defines neither, so a selector it rejects throws a constructor TypeError
 * instead of the parse error naming the selector. A suite that renders anything
 * running selectors (`querySelectorAll`, a Base UI popover, the ConfirmDialog)
 * calls this before it imports React.
 */
export function defineHappyDomErrorClasses(): void {
  // The DOM lib declares both classes on every `window`; happy-dom's lacks them,
  // and outside a DOM suite there is no `window` at all.
  const win: Partial<Pick<typeof globalThis, "SyntaxError" | "TypeError">> | undefined =
    globalThis.window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

/** Resizes the test window, as a phone or a desktop browser would be. */
export function setHappyDomViewport(size: { width: number; height: number }): void {
  happyDomWindow.happyDOM.setViewport(size);
}
