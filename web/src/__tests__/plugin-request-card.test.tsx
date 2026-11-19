// ---------------------------------------------------------------------------
// PluginRequestCard — the agent asked the person to turn on one of their own
// plugins in the chat's workspace (ADR-0069 "Only the owner grants").
//
// Use here makes the first-party grant and sends the answer as the person's
// next message; Not now sends the answer and grants nothing. The card shows
// only the caller's own plugins, from their listing, and takes an answer only
// on the latest message once the turn has stopped.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type * as ApiClient from "../api/client";
import type { PersonalConnector } from "../api/client";
import type { ChatAnswer } from "../context/ChatAnswerContext";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";

const CONVERSATION_ID = "conv_0042";

const grantConnector = mock<typeof ApiClient.grantConnector>(async () => {});
let personal: PersonalConnector[] = [];
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: personal,
}));
/** Where the vendor's sign-in page is; null means it connected without leaving. */
let authorizationUrl: string | null = "https://granola.test/authorize?state=s";
const initiateIdentityConnect = mock<typeof ApiClient.initiateIdentityConnect>(async () => ({
  authorizationUrl,
}));
const initiateComposioIdentityConnect = mock<typeof ApiClient.initiateComposioIdentityConnect>(
  async () => ({ authorizationUrl: authorizationUrl ?? "" }),
);
mock.module("../api/client", () => ({
  ...realClient,
  grantConnector,
  listPersonalConnectors,
  initiateIdentityConnect,
  initiateComposioIdentityConnect,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ChatAnswerContext } = await import("../context/ChatAnswerContext");
const { ChatPluginsContext } = await import("../context/ChatPluginsContext");
const { PluginRequestCard } = await import("../components/PluginRequestCard");
const { MessageList } = await import("../components/MessageList");
const { MemoryRouter } = await import("react-router-dom");
type ChatMessage = import("../hooks/chat-store").ChatMessage;
const { requestedPluginName, markSignInPending, isSignInPending } = await import(
  "../lib/plugin-request"
);

const GRANOLA: Plugin = {
  id: "person:granola",
  displayName: "Granola",
  owner: { kind: "person" },
  granted: false,
  servers: [{ serverName: "granola", status: "ready", account: { email: "pat@acme.test" } }],
  skills: [],
  apps: [],
};
/** A workspace plugin of the same name: never a personal plugin to ask for. */
const TEAM_NOTION: Plugin = {
  id: "workspace:notion",
  displayName: "Notion",
  owner: { kind: "workspace" },
  granted: true,
  servers: [{ serverName: "notion", status: "ready", account: null }],
  skills: [],
  apps: [],
};

const send = mock<ChatAnswer["send"]>(async () => {});

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

let assign: ReturnType<typeof spyOn<Location, "assign">>;

beforeEach(() => {
  for (const m of [
    grantConnector,
    send,
    listPersonalConnectors,
    initiateIdentityConnect,
    initiateComposioIdentityConnect,
  ]) {
    m.mockClear();
  }
  personal = [];
  authorizationUrl = "https://granola.test/authorize?state=s";
  sessionStorage.clear();
  // The sign-in leaves the page; the test reads where it was sent instead.
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  assign.mockRestore();
});

function render(opts: {
  serverName: string;
  plugins?: Plugin[];
  isLatestMessage?: boolean;
  canAnswer?: boolean;
}) {
  const answer: ChatAnswer = {
    conversationId: CONVERSATION_ID,
    workspaceId: WS_ID,
    workspaceName: "Helix",
    canAnswer: opts.canAnswer ?? true,
    send,
  };
  act(() =>
    root.render(
      <ChatPluginsContext value={opts.plugins ?? [GRANOLA, TEAM_NOTION]}>
        <ChatAnswerContext value={answer}>
          <PluginRequestCard
            serverName={opts.serverName}
            isLatestMessage={opts.isLatestMessage ?? true}
          />
        </ChatAnswerContext>
      </ChatPluginsContext>,
    ),
  );
}

function button(testId: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("PluginRequestCard", () => {
  test("asks the Plugins page's question with the plugin's account and the workspace", () => {
    render({ serverName: "granola" });
    expect(container.textContent).toContain("Use Granola (pat@acme.test) in Helix?");
    expect(container.textContent).toContain("Only you can use it here; other members can't.");
  });

  test("Use here grants through the first-party path and answers as the person", async () => {
    render({ serverName: "granola" });
    await act(async () => button("plugin-request-use")?.click());
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(send).toHaveBeenCalledWith("I turned on Granola in this workspace. Go ahead.", {
      serverName: "granola",
      answer: "use",
    });
    expect(container.textContent).toContain("Turned on here.");
    expect(button("plugin-request-use")).toBeNull();
  });

  test("Not now grants nothing and answers as the person", async () => {
    render({ serverName: "granola" });
    await act(async () => button("plugin-request-not-now")?.click());
    expect(grantConnector).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Not now: don't use Granola in this workspace.", {
      serverName: "granola",
      answer: "not_now",
    });
    expect(container.textContent).toContain("Not turned on.");
  });

  test("a failed grant sends no answer", async () => {
    grantConnector.mockImplementationOnce(async () => {
      throw new Error("refused");
    });
    render({ serverName: "granola" });
    await act(async () => button("plugin-request-use")?.click());
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("refused");
  });

  test("renders nothing for a name that is not one of the caller's plugins", () => {
    render({ serverName: "notion" });
    expect(container.textContent).toBe("");
    render({ serverName: "someone-elses" });
    expect(container.textContent).toBe("");
  });

  test("a plugin already on here offers no answer", () => {
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    expect(container.textContent).toContain("Turned on here.");
    expect(button("plugin-request-use")).toBeNull();
  });

  test("an older message, or a running turn, takes no answer", () => {
    render({ serverName: "granola", isLatestMessage: false });
    expect(button("plugin-request-use")).toBeNull();
    render({ serverName: "granola", canAnswer: false });
    expect(button("plugin-request-use")).toBeNull();
  });
});

// Use here on a plugin with no account behind it turns it on and signs in,
// returning to this conversation; the answer goes once the person is back with
// it connected, never before they leave.
describe("PluginRequestCard — a plugin that is not signed in", () => {
  const NOT_SIGNED_IN: Plugin = {
    ...GRANOLA,
    servers: [{ serverName: "granola", status: "not_connected", account: null }],
  };
  const CONNECTOR: PersonalConnector = {
    serverName: "granola",
    displayName: "Granola",
    description: null,
    state: "not_authenticated",
    auth: "dcr",
    grantedWorkspaces: [],
  };
  const returnPath = `${window.location.pathname}?chat=${CONVERSATION_ID}`;

  test("says the sign-in comes next", () => {
    render({ serverName: "granola", plugins: [NOT_SIGNED_IN] });
    expect(container.textContent).toContain("You'll sign in to Granola next.");
  });

  test("Use here grants, then signs in back to this conversation, and does not answer yet", async () => {
    personal = [CONNECTOR];
    render({ serverName: "granola", plugins: [NOT_SIGNED_IN] });
    await act(async () => button("plugin-request-use")?.click());

    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola", returnPath);
    expect(grantConnector.mock.invocationCallOrder[0]).toBeLessThan(
      initiateIdentityConnect.mock.invocationCallOrder[0]!,
    );
    expect(assign).toHaveBeenCalledWith("https://granola.test/authorize?state=s");
    expect(send).not.toHaveBeenCalled();
    expect(isSignInPending(CONVERSATION_ID, "granola")).toBe(true);
  });

  test("a Composio plugin keys its sign-in on the catalog id", async () => {
    personal = [{ ...CONNECTOR, auth: "composio", connectorId: "ai.granola/granola" }];
    render({ serverName: "granola", plugins: [NOT_SIGNED_IN] });
    await act(async () => button("plugin-request-use")?.click());
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith("ai.granola/granola", returnPath);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("back from the sign-in with it connected, the card answers once", async () => {
    markSignInPending(CONVERSATION_ID, "granola");
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("I turned on Granola in this workspace. Go ahead.", {
      serverName: "granola",
      answer: "use",
    });
    expect(isSignInPending(CONVERSATION_ID, "granola")).toBe(false);

    // A later render (a listing refresh) sends nothing more.
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("back but not yet connected, the card waits and offers Connect", async () => {
    markSignInPending(CONVERSATION_ID, "granola");
    render({ serverName: "granola", plugins: [{ ...NOT_SIGNED_IN, granted: true }] });
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("On here. Sign in to Granola to finish.");
    expect(button("plugin-request-connect")).not.toBeNull();

    // The connection finishing (an SSE refresh of the listing) sends the answer.
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("a card this tab never sent to sign in does not answer on its own", async () => {
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
    // Another conversation's sign-in is not this card's.
    markSignInPending("conv_other", "granola");
    render({ serverName: "granola", plugins: [{ ...GRANOLA, granted: true }] });
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
  });

  test("Connect on a plugin on here signs in and answers on return", async () => {
    personal = [CONNECTOR];
    render({ serverName: "granola", plugins: [{ ...NOT_SIGNED_IN, granted: true }] });
    await act(async () => button("plugin-request-connect")?.click());
    expect(grantConnector).not.toHaveBeenCalled();
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola", returnPath);
    expect(send).not.toHaveBeenCalled();
    expect(isSignInPending(CONVERSATION_ID, "granola")).toBe(true);
  });

  test("a sign-in that connects without leaving answers at once", async () => {
    personal = [CONNECTOR];
    authorizationUrl = null;
    render({ serverName: "granola", plugins: [NOT_SIGNED_IN] });
    await act(async () => button("plugin-request-use")?.click());
    expect(assign).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(isSignInPending(CONVERSATION_ID, "granola")).toBe(false);
  });

  test("Not now is unchanged: no grant, no sign-in", async () => {
    render({ serverName: "granola", plugins: [NOT_SIGNED_IN] });
    await act(async () => button("plugin-request-not-now")?.click());
    expect(grantConnector).not.toHaveBeenCalled();
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Not now: don't use Granola in this workspace.", {
      serverName: "granola",
      answer: "not_now",
    });
  });
});

describe("requestedPluginName", () => {
  test("reads a finished nb__manage_tools request_plugin call, and nothing else", () => {
    const call = {
      id: "c1",
      name: "nb__manage_tools",
      status: "done" as const,
      input: { request_plugin: "granola" },
    };
    expect(requestedPluginName(call)).toBe("granola");
    expect(requestedPluginName({ ...call, status: "error" })).toBeNull();
    expect(requestedPluginName({ ...call, input: { add: ["x__y"] } })).toBeNull();
    expect(requestedPluginName({ ...call, name: "crm__manage_tools" })).toBeNull();
  });
});

describe("the answer a card sent", () => {
  const typed: ChatMessage = {
    role: "user",
    content: "I turned on Granola in this workspace. Go ahead.",
    timestamp: "2026-11-18T00:00:00.000Z",
  };

  function renderMessages(messages: ChatMessage[]) {
    act(() =>
      root.render(
        <MemoryRouter>
          <ChatPluginsContext value={[GRANOLA]}>
            <MessageList
              messages={messages}
              isStreaming={false}
              streamingState={null}
              displayDetail="balanced"
            />
          </ChatPluginsContext>
        </MemoryRouter>,
      ),
    );
  }

  test("Use here's message reads as the answer, not a bubble the person typed", () => {
    renderMessages([{ ...typed, pluginRequestAnswer: { serverName: "granola", answer: "use" } }]);
    const line = container.querySelector('[data-testid="plugin-request-answer"]');
    expect(line?.textContent).toBe("You turned on Granola here");
    expect(container.querySelector(".presence-user-message")).toBeNull();
  });

  test("Not now's message reads as the answer", () => {
    renderMessages([
      {
        ...typed,
        content: "Not now: don't use Granola in this workspace.",
        pluginRequestAnswer: { serverName: "granola", answer: "not_now" },
      },
    ]);
    expect(container.querySelector('[data-testid="plugin-request-answer"]')?.textContent).toBe(
      "You chose not now for Granola",
    );
  });

  test("the same words typed by the person stay their bubble", () => {
    renderMessages([typed]);
    expect(container.querySelector('[data-testid="plugin-request-answer"]')).toBeNull();
    expect(container.querySelector(".presence-user-message")?.textContent).toBe(typed.content);
  });
});
