// ---------------------------------------------------------------------------
// PostHog URL scrubbing: every URL-valued property leaves without its query or
// fragment, which can name what the person is looking at (`?chat=`, an app's record).
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { CaptureResult } from "posthog-js";
import { scrubUrls } from "../src/telemetry";

describe("scrubUrls", () => {
  test("strips the query and fragment from every URL-valued property, set-once included", () => {
    const event: CaptureResult = {
      uuid: "u1",
      event: "chat_sent",
      properties: {
        $current_url: "https://app.example/w/abc/app/crm?target=crm://contacts/c1",
        $referrer: "https://app.example/w/abc/?chat=conv_1#top",
        $pathname: "/w/abc/app/crm",
        count: 3,
      },
      $set_once: { $initial_current_url: "https://app.example/w/abc/?chat=conv_1" },
    };

    const out = scrubUrls(event);
    expect(out?.properties.$current_url).toBe("https://app.example/w/abc/app/crm");
    expect(out?.properties.$referrer).toBe("https://app.example/w/abc/");
    expect(out?.properties.$pathname).toBe("/w/abc/app/crm");
    expect(out?.properties.count).toBe(3);
    expect(out?.$set_once?.$initial_current_url).toBe("https://app.example/w/abc/");
  });

  test("passes a dropped event through", () => {
    expect(scrubUrls(null)).toBeNull();
  });
});
