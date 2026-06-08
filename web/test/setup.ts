import { Window } from "happy-dom";

// Snapshot of the real `../src/api/client` module, captured here in the test
// preload — guaranteed to run before any test file, so before any test can
// register a `mock.module("../api/client", ...)` replacement. Several suites
// whole-module-mock api/client but only stub the one or two functions they
// call; spreading this snapshot into those mocks keeps every other export
// present. Bun's `mock.module` registry is process-global, so an incomplete
// replacement leaking into another file's module graph (a concurrency-order
// race that only manifests on CI) is what produced the flaky
// "Export named 'getActiveWorkspaceId' not found" link errors.
//
// Why a preload snapshot rather than `await import("../api/client")` inside
// each test: that dynamic import reads the *same* global registry it's trying
// to defend against, so under the wrong load order it can itself resolve to an
// incomplete mock and propagate the gap. Capturing here, before any mock
// exists, and copying into a plain object makes the snapshot immune to later
// `mock.module` swaps.
import * as realApiClient from "../src/api/client";

export const realClient = { ...realApiClient };

// Same defense for `conversation-stream`. chat-store.test / chatBleed /
// inlineError all `mock.module("../api/conversation-stream", ...)` with a
// fake `connectConversationStream` (they test chat-store without real SSE).
// That mock is process-global and never unwinds, so conversation-stream's
// OWN test — which needs the real watchdog/visibility implementation — gets
// the fake if it runs after any of them. Capturing the real module here, in
// the preload before any mock exists, gives that test a stable handle.
import * as realConversationStreamMod from "../src/api/conversation-stream";

export const realConversationStream = { ...realConversationStreamMod };

const window = new Window({ url: "http://localhost" });

// Register DOM globals that React and testing-library need
for (const key of Object.getOwnPropertyNames(window)) {
	if (key.startsWith("_")) continue;
	if (key in globalThis) continue;
	try {
		Object.defineProperty(globalThis, key, {
			value: (window as Record<string, unknown>)[key],
			writable: true,
			configurable: true,
		});
	} catch {
		// Skip non-configurable properties
	}
}

// Ensure document and window are set
Object.defineProperty(globalThis, "document", {
	value: window.document,
	writable: true,
	configurable: true,
});
Object.defineProperty(globalThis, "window", {
	value: window,
	writable: true,
	configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
	value: window.navigator,
	writable: true,
	configurable: true,
});
Object.defineProperty(globalThis, "HTMLElement", {
	value: window.HTMLElement,
	writable: true,
	configurable: true,
});
