import { describe, expect, it, mock } from "bun:test";
import { realClient } from "./setup";

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap. Same patch the
// SkillsBrowser suite uses.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

// The component module imports `callTool`; mock it before the module is first
// evaluated, then pull the component (and the pure `relativeTime` export) via
// dynamic import so they bind to the mock. Same ordering the SkillsBrowser
// suite uses.
type ListCall = { server: string; tool: string; args: Record<string, unknown> };
const listCalls: ListCall[] = [];
let listImpl: () => Promise<unknown> = async () => ({
  structuredContent: { conversations: [], nextCursor: null, totalCount: 0 },
});

mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
    listCalls.push({ server, tool, args });
    return listImpl();
  },
}));

const React = await import("react");
const { act } = await import("react");
const { render, fireEvent, waitFor } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");
const { RecentConversationsPopover, relativeTime } = await import(
  "../src/components/RecentConversationsPopover"
);

// ── relativeTime (pure) ────────────────────────────────────────────────────

describe("relativeTime", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("returns 'now' under a minute", () => expect(relativeTime(ago(30_000))).toBe("now"));
  it("returns minutes under an hour", () => expect(relativeTime(ago(5 * 60_000))).toBe("5m"));
  it("returns hours under a day", () => expect(relativeTime(ago(3 * 3_600_000))).toBe("3h"));
  it("returns 'Yst' between one and two days", () =>
    expect(relativeTime(ago(26 * 3_600_000))).toBe("Yst"));
  it("returns a weekday name within the week", () => {
    const r = relativeTime(ago(3 * 86_400_000));
    expect(r).not.toBe("Yst");
    expect(r).toMatch(/[A-Za-z]/);
  });
  it("returns a calendar date beyond a week", () =>
    expect(relativeTime(ago(10 * 86_400_000))).toMatch(/[A-Za-z]/));
  it("returns '' for an unparseable date", () => expect(relativeTime("nope")).toBe(""));
});

// ── popover render states ───────────────────────────────────────────────────

async function openPopover(opts: { onOpen?: (id: string) => void; activeId?: string | null } = {}) {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(RecentConversationsPopover, {
          activeConversationId: opts.activeId ?? null,
          onOpen: opts.onOpen ?? (() => {}),
        }),
      ),
    ));
  });
  const btn = container.querySelector(
    'button[aria-label="Recent conversations"]',
  ) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(btn);
  });
  return container;
}

function conv(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    title: "Bytemark research",
    preview: "pull the notes",
    createdAt: "",
    updatedAt: new Date(Date.now() - 30_000).toISOString(),
    workspaceId: null,
    ...over,
  };
}

describe("RecentConversationsPopover", () => {
  it("requests the 10 most recent conversations, sorted by updated", async () => {
    listCalls.length = 0;
    listImpl = async () => ({ structuredContent: { conversations: [], nextCursor: null, totalCount: 0 } });
    await openPopover();
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    const call = listCalls.at(-1)!;
    expect(call.server).toBe("conversations");
    expect(call.tool).toBe("list");
    expect(call.args.limit).toBe(10);
    expect(call.args.sortBy).toBe("updated");
  });

  it("renders a row with title, preview, and relative time", async () => {
    listImpl = async () => ({
      structuredContent: { conversations: [conv()], nextCursor: null, totalCount: 1 },
    });
    const container = await openPopover();
    await waitFor(() => {
      expect(container.textContent).toContain("Bytemark research");
      expect(container.textContent).toContain("pull the notes");
      expect(container.textContent).toContain("now");
    });
  });

  it("shows the empty state when there are no conversations", async () => {
    listImpl = async () => ({ structuredContent: { conversations: [], nextCursor: null, totalCount: 0 } });
    const container = await openPopover();
    await waitFor(() => expect(container.textContent).toContain("No conversations yet"));
  });

  it("shows an error state when the tool call fails", async () => {
    listImpl = async () => {
      throw new Error("boom");
    };
    const container = await openPopover();
    await waitFor(() => expect(container.textContent).toContain("boom"));
  });

  it("calls onOpen with the row id when a row is clicked", async () => {
    let opened: string | null = null;
    listImpl = async () => ({
      structuredContent: {
        conversations: [conv({ id: "c9", title: "Pick me", preview: "" })],
        nextCursor: null,
        totalCount: 1,
      },
    });
    const container = await openPopover({ onOpen: (id) => (opened = id) });
    let row: HTMLButtonElement | undefined;
    await waitFor(() => {
      row = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Pick me"),
      ) as HTMLButtonElement | undefined;
      expect(row).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(row as HTMLButtonElement);
    });
    expect(opened).toBe("c9");
  });
});
