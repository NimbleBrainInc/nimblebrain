// ---------------------------------------------------------------------------
// ChatConfigContext.refreshConfig — every `config.changed` starts a re-read,
// and two can be in flight at once (two quick preference saves). The answer to
// the latest request is the one applied, whatever order they arrive in, so an
// older read never replaces a newer preference.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";
import type { ToolCallResponse } from "../types";

const replies: ((res: ToolCallResponse) => void)[] = [];
const callToolWithoutWorkspace = mock<typeof ApiClient.callToolWithoutWorkspace>(
  () =>
    new Promise<ToolCallResponse>((resolve) => {
      replies.push(resolve);
    }),
);

mock.module("../api/client", () => ({ ...realClient, callToolWithoutWorkspace }));

const { ChatProvider, useChatConfigContext } = await import("../context/ChatContext");

const configWithTheme = (theme: string): ToolCallResponse => ({
  content: [],
  structuredContent: { preferences: { theme } },
  isError: false,
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ChatProvider initialConfig={{ configuredProviders: [], preferences: { theme: "system" } }}>
        {children}
      </ChatProvider>
    </MemoryRouter>
  );
}

describe("refreshConfig", () => {
  test("an older read arriving last does not replace a newer one", async () => {
    const { result } = renderHook(() => useChatConfigContext(), { wrapper });

    act(() => result.current.refreshConfig());
    act(() => result.current.refreshConfig());
    expect(replies).toHaveLength(2);

    await act(async () => replies[1]?.(configWithTheme("light")));
    await act(async () => replies[0]?.(configWithTheme("dark")));

    expect(result.current.preferences?.theme).toBe("light");
  });
});
