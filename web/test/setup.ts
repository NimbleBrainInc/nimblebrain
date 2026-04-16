import { Window } from "happy-dom";

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
