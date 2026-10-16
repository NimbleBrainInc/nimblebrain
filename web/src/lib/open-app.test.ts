import { afterEach, describe, expect, test } from "bun:test";
import { destinationFrom, provideShellOpener, shellOpenCallbacks } from "./open-app";

describe("destinationFrom", () => {
  test("reads a conversation or an app destination, with its target", () => {
    expect(destinationFrom({ conversationId: "conv_1" })).toEqual({ conversationId: "conv_1" });
    expect(destinationFrom({ app: "files", name: "Files", target: "files://fl_1" })).toEqual({
      app: "files",
      name: "Files",
      target: "files://fl_1",
    });
    expect(destinationFrom({ app: "people", name: "People" })).toEqual({
      app: "people",
      name: "People",
    });
  });

  test("anything else is no destination", () => {
    expect(destinationFrom(undefined)).toBeNull();
    expect(destinationFrom({ app: "people" })).toBeNull();
    expect(destinationFrom("files://fl_1")).toBeNull();
  });
});

describe("shellOpenCallbacks", () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  test("reach the opener the shell registered, looked up when called", async () => {
    const seen: string[] = [];
    const callbacks = shellOpenCallbacks;
    off = provideShellOpener({
      open: async (uri) => void seen.push(`open ${uri}`),
      openConnectorSettings: async (s) => void seen.push(`settings ${s}`),
    });
    await callbacks.onOpen("files://fl_1");
    await callbacks.onOpenConnectorSettings("crm");
    expect(seen).toEqual(["open files://fl_1", "settings crm"]);
  });

  test("with no shell registered, each rejects instead of waiting", async () => {
    await expect(shellOpenCallbacks.onOpen("files://fl_1")).rejects.toThrow();
    await expect(shellOpenCallbacks.onOpenConnectorSettings("crm")).rejects.toThrow();
  });
});
