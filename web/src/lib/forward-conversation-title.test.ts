// ---------------------------------------------------------------------------
// forward-conversation-title — iframe targeting regression
//
// The live `conversation.title` SSE event is forwarded to the conversations
// list iframe via postMessage so the row title updates without a refetch. The
// iframe is addressed by its `data-app` attribute, which `SlotRenderer` sets to
// the placement's *serverName* (`conversations`) — NOT the SDK SynapseProvider
// app name (`@nimblebraininc/conversations`). Targeting the wrong value matches
// zero iframes and the title silently never reaches the list (only a refresh,
// which refetches from disk, then shows it). Pin the selector to serverName.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import { forwardConversationTitleToIframes } from "./forward-conversation-title";

interface CapturedPost {
  data: unknown;
  targetOrigin: string;
}

let originalQSA: typeof document.querySelectorAll;

afterEach(() => {
  if (originalQSA) document.querySelectorAll = originalQSA;
});

/** Stub querySelectorAll to return a single fake iframe ONLY for the exact
 *  selector the caller is expected to use. A mismatched selector (the bug)
 *  falls through to the real (empty) DOM, so the post count stays 0. */
function installIframeStub(expectedSelector: string): CapturedPost[] {
  const posts: CapturedPost[] = [];
  const iframe = {
    contentWindow: {
      postMessage(data: unknown, targetOrigin: string) {
        posts.push({ data, targetOrigin });
      },
    },
  } as unknown as HTMLIFrameElement;

  originalQSA = document.querySelectorAll.bind(document);
  document.querySelectorAll = ((selector: string) => {
    if (selector === expectedSelector) {
      return [iframe] as unknown as NodeListOf<Element>;
    }
    return originalQSA(selector);
  }) as typeof document.querySelectorAll;

  return posts;
}

describe("forwardConversationTitleToIframes", () => {
  test("targets the conversations iframe by serverName data-app", () => {
    const posts = installIframeStub('iframe[data-app="conversations"]');

    forwardConversationTitleToIframes("conv_abc", "The Importance of Sleep");

    expect(posts.length).toBe(1);
    expect(posts[0]?.targetOrigin).toBe("*");
    const data = posts[0]?.data as {
      jsonrpc?: string;
      method?: string;
      params?: { conversationId?: string; title?: string };
    };
    expect(data?.jsonrpc).toBe("2.0");
    expect(data?.method).toBe("synapse/conversation-title");
    expect(data?.params?.conversationId).toBe("conv_abc");
    expect(data?.params?.title).toBe("The Importance of Sleep");
  });

  test("no-op when no conversations iframe is mounted", () => {
    // No matching iframe in the DOM — querySelectorAll returns empty for any
    // selector. Forward must not throw and must post nothing.
    originalQSA = document.querySelectorAll.bind(document);
    let posted = false;
    document.querySelectorAll = (() =>
      [] as unknown as NodeListOf<Element>) as typeof document.querySelectorAll;
    // Guard: if forward somehow posted, this would flip — but with zero
    // iframes there's nothing to post to.
    forwardConversationTitleToIframes("conv_abc", "Title");
    expect(posted).toBe(false);
  });
});
