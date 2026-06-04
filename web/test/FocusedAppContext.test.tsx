import { describe, expect, it } from "bun:test";
import { act, render, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { FocusedAppProvider, useFocusedApp } from "../src/context/FocusedAppContext";
import type { AppContext } from "../src/types";

// --------------------------------------------------------------------------
// Regression: a message typed into the global chat panel while an app is
// focused must carry that app's AppContext. The panel (ChatChrome) can't
// know the focused app on its own — the active app view (AppWithChat)
// publishes it here and the panel reads it. These tests pin that
// publish→read contract across two separate components.
// --------------------------------------------------------------------------

const COLLATERAL: AppContext = {
  appName: "Collateral Studio",
  serverName: "synapse-collateral",
};

describe("FocusedAppContext", () => {
  it("defaults to no focused app", () => {
    const { result } = renderHook(() => useFocusedApp(), {
      wrapper: FocusedAppProvider,
    });
    expect(result.current.focusedApp).toBeNull();
  });

  it("returns an inert value (no throw, no-op setter) outside a provider", () => {
    const { result } = renderHook(() => useFocusedApp());
    expect(result.current.focusedApp).toBeNull();
    // Must not throw — components render in isolation (tests, storybook).
    expect(() => result.current.setFocusedApp(COLLATERAL)).not.toThrow();
  });

  it("publishes the focused app from one component to a reader in another", () => {
    let seen: AppContext | null | undefined;

    // Mimics AppWithChat: publishes itself while mounted, clears on unmount.
    function Publisher({ app }: { app: AppContext }) {
      const { setFocusedApp } = useFocusedApp();
      useEffect(() => {
        setFocusedApp(app);
        return () => setFocusedApp(null);
      }, [app, setFocusedApp]);
      return null;
    }

    // Mimics ChatChrome: reads the focused app to stamp on outgoing messages.
    function Reader() {
      seen = useFocusedApp().focusedApp;
      return null;
    }

    const { rerender } = render(
      <FocusedAppProvider>
        <Publisher app={COLLATERAL} />
        <Reader />
      </FocusedAppProvider>,
    );

    expect(seen).toEqual(COLLATERAL);

    // Navigating away unmounts the app view → reader stamps nothing.
    rerender(
      <FocusedAppProvider>
        <Reader />
      </FocusedAppProvider>,
    );

    expect(seen).toBeNull();
  });

  it("clears the focused app when set back to null", () => {
    const { result } = renderHook(() => useFocusedApp(), {
      wrapper: FocusedAppProvider,
    });

    act(() => result.current.setFocusedApp(COLLATERAL));
    expect(result.current.focusedApp).toEqual(COLLATERAL);

    act(() => result.current.setFocusedApp(null));
    expect(result.current.focusedApp).toBeNull();
  });
});
