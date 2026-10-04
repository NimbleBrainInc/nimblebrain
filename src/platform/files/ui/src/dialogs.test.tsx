/**
 * The name dialog must not use a <form>: the host's sandbox withholds
 * allow-forms, so the browser blocks a form submit before any handler runs and
 * Create or Rename does nothing.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NameDialog } from "./Dialogs";

describe("NameDialog", () => {
  test("renders no <form>, and its button is not a submit", () => {
    const html = renderToStaticMarkup(
      createElement(NameDialog, {
        title: "New folder",
        initial: "Reports",
        submitLabel: "Create",
        onSubmit: async () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("Create");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
  });
});
