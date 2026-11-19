import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import type { Notice } from "../notices";
import { type ReturnedConnector, returnOutcome } from "./useConnectedNotice";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const granola = (state: ReturnedConnector["state"]): ReturnedConnector => ({
  serverName: "granola",
  displayName: "Granola",
  state,
});

describe("returnOutcome", () => {
  test("a connected connector is confirmed by its display name", () => {
    expect(returnOutcome({ serverName: "granola" }, [granola("connected")])).toEqual({
      kind: "connected",
      name: "Granola",
    });
  });

  test("waits while the token exchange is still settling", () => {
    expect(returnOutcome({ serverName: "granola" }, [granola("pending")])).toEqual({
      kind: "wait",
    });
  });

  test("a connector that failed is reported, not confirmed", () => {
    expect(returnOutcome({ serverName: "granola" }, [granola("failed")])).toEqual({
      kind: "failed",
      name: "Granola",
    });
  });

  test("a name the page does not list announces nothing", () => {
    expect(returnOutcome({ serverName: "not-installed" }, [granola("connected")])).toEqual({
      kind: "absent",
    });
  });

  test("with an owner named, answers for that owner's install of a shared server name", () => {
    const listed: ReturnedConnector[] = [
      { ...granola("pending"), owner: "workspace" },
      { ...granola("connected"), owner: "person" },
    ];
    expect(returnOutcome({ serverName: "granola", owner: "person" }, listed)).toEqual({
      kind: "connected",
      name: "Granola",
    });
    expect(returnOutcome({ serverName: "granola", owner: "workspace" }, listed)).toEqual({
      kind: "wait",
    });
  });

  test("falls back to the server name when there is no display name", () => {
    const bare = { serverName: "granola", displayName: "", state: "connected" as const };
    expect(returnOutcome({ serverName: "granola" }, [bare])).toEqual({
      kind: "connected",
      name: "granola",
    });
  });
});

// The hook itself, mounted under a router at the URL the OAuth callback
// redirects to. `useNotice` is replaced so each raised notice is recorded.

const notices: Notice[] = [];
mock.module("../notices", () => ({ useNotice: () => (n: Notice) => notices.push(n) }));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { useConnectedNotice } = await import("./useConnectedNotice");

interface Props {
  connectors: readonly ReturnedConnector[] | null;
}

function mount(url: string, connectors: readonly ReturnedConnector[] | null) {
  const refresh = jest.fn();
  const location = { current: "" };
  const hook = renderHook(
    ({ connectors }: Props) => {
      const justConnected = useConnectedNotice(connectors, refresh);
      const loc = useLocation();
      location.current = `${loc.pathname}${loc.search}`;
      return justConnected;
    },
    {
      initialProps: { connectors },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(MemoryRouter, { initialEntries: [url] }, children),
    },
  );
  return { ...hook, refresh, location };
}

describe("useConnectedNotice", () => {
  beforeEach(() => {
    notices.length = 0;
    jest.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test("takes the parameter off the URL and keeps the others", () => {
    const { location } = mount("/connectors?tab=all&connected=granola", null);
    expect(location.current).toBe("/connectors?tab=all");
  });

  test("confirms once, after the connector settles", () => {
    const { rerender } = mount("/connectors?connected=granola", [granola("pending")]);
    expect(notices).toEqual([]);
    rerender({ connectors: [granola("connected")] });
    rerender({ connectors: [granola("connected")] });
    expect(notices).toEqual([{ level: "success", title: "Connected to Granola" }]);
  });

  test("reports a connector that failed, and marks no row", () => {
    const { result } = mount("/connectors?connected=granola", [granola("failed")]);
    expect(notices).toEqual([{ level: "error", title: "Couldn't connect to Granola" }]);
    expect(result.current).toBeNull();
  });

  test("names the connector to mark once it connects, and keeps it after re-reads", () => {
    const { result, rerender } = mount("/connectors?connected=granola", [granola("pending")]);
    expect(result.current).toBeNull();
    rerender({ connectors: [granola("connected")] });
    expect(result.current).toEqual({ serverName: "granola" });
    rerender({ connectors: [granola("connected")] });
    expect(result.current).toEqual({ serverName: "granola" });
  });

  test("takes the owner off the URL too, and marks that owner's install", () => {
    const { result, location } = mount("/w/x/plugins?connected=granola&owner=person", [
      { ...granola("connected"), owner: "workspace" },
      { ...granola("connected"), owner: "person" },
    ]);
    expect(location.current).toBe("/w/x/plugins");
    expect(result.current).toEqual({ serverName: "granola", owner: "person" });
  });

  test("a name the page does not list announces nothing and stops polling", () => {
    const { refresh } = mount("/connectors?connected=other", [granola("connected")]);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(notices).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("re-reads the list while pending, and gives up after the limit", () => {
    const { refresh } = mount("/connectors?connected=granola", [granola("pending")]);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(refresh).toHaveBeenCalledTimes(3);
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    expect(refresh).toHaveBeenCalledTimes(15);
    expect(notices).toEqual([]);
  });

  test("stops polling on unmount", () => {
    const { refresh, unmount } = mount("/connectors?connected=granola", [granola("pending")]);
    unmount();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
