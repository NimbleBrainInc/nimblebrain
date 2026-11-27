import type { Notice } from "@nimblebrain/synapse";

/** The host takes a notice title of up to 120 characters. */
const MAX_TITLE = 120;

/** A message as a notice title: one over the host's limit (a long filename) is cut. */
export function noticeTitle(message: string): string {
  return message.length > MAX_TITLE ? `${message.slice(0, MAX_TITLE - 1)}…` : message;
}

/**
 * Confirm a finished action in the host's notice. Where the host shows none
 * (it does not declare notify, or refuses a burst), `showOwn` shows the app's
 * own instead.
 */
export function confirmAction(
  notify: (notice: Notice) => Promise<boolean>,
  message: string,
  showOwn: (message: string) => void,
): Promise<void> {
  return notify({ level: "success", title: noticeTitle(message) }).then(
    (shown) => {
      if (!shown) showOwn(message);
    },
    () => showOwn(message),
  );
}
