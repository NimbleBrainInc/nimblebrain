/**
 * A finished action is confirmed in the host's notice, and in the app's own
 * pill only where the host shows none: it does not declare notify (resolves
 * false) or refuses the notice (rejects).
 */

import { describe, expect, test } from "bun:test";
import type { Notice } from "@nimblebrain/synapse";
import { confirmAction, noticeTitle } from "./notice";

function run(answer: Promise<boolean>) {
  const sent: Notice[] = [];
  const own: string[] = [];
  const done = confirmAction(
    (notice) => {
      sent.push(notice);
      return answer;
    },
    "Created folder Reports",
    (m) => own.push(m),
  );
  return { sent, own, done };
}

describe("confirmAction", () => {
  test("a notice the host shows is not shown again by the app", async () => {
    const { sent, own, done } = run(Promise.resolve(true));
    await done;
    expect(sent).toEqual([{ level: "success", title: "Created folder Reports" }]);
    expect(own).toEqual([]);
  });

  test("a host without notify gets the app's own pill", async () => {
    const { own, done } = run(Promise.resolve(false));
    await done;
    expect(own).toEqual(["Created folder Reports"]);
  });

  test("a notice the host refuses gets the app's own pill", async () => {
    const { own, done } = run(Promise.reject(new Error("Too many notices")));
    await done;
    expect(own).toEqual(["Created folder Reports"]);
  });
});

describe("noticeTitle", () => {
  test("keeps a title within the host's 120 characters", () => {
    expect(noticeTitle("a".repeat(120))).toBe("a".repeat(120));
  });

  test("cuts a longer one to 120, ending in an ellipsis", () => {
    const title = noticeTitle(`Deleted ${"x".repeat(200)}`);
    expect(title.length).toBe(120);
    expect(title.endsWith("…")).toBe(true);
  });
});
