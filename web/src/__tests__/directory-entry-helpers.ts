// Reading and driving the plugin directory in tests: a row per entry, each
// opening the entry's page, where Install is. Shared by the Browse tests so
// every one reaches an install the way a person does.

import { act } from "react";

/** The directory row whose name is `name`. Throws when there is none. */
export function entryRow(container: ParentNode, name: string): HTMLElement {
  const link = Array.from(
    container.querySelectorAll<HTMLAnchorElement>('[data-testid="directory-entry"] a'),
  ).find((a) => a.textContent === name);
  const row = link?.closest<HTMLElement>('[data-testid="directory-entry"]');
  if (!row) throw new Error(`no directory row for ${name}`);
  return row;
}

/** The entry page in view, or null on the list. */
export function entryPage(container: ParentNode): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="directory-entry-page"]');
}

/** Opens `name`'s page from its row, as a click on the row does, and returns it. */
export async function openEntry(container: ParentNode, name: string): Promise<HTMLElement> {
  const link = entryRow(container, name).querySelector("a");
  await act(async () => {
    link?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  const page = entryPage(container);
  if (!page) throw new Error(`${name}'s page did not open`);
  return page;
}

/** The button whose text is exactly `text`: "Install" never matches "Installed". */
export function buttonNamed(scope: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(scope.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) ?? null
  );
}
