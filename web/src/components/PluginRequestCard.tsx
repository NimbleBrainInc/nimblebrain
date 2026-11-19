import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Plugin, PluginRequestAnswer } from "../_generated/platform-schemas/plugins";
import { grantConnector, listPersonalConnectors } from "../api/client";
import { useChatAnswer } from "../context/ChatAnswerContext";
import { useChatPlugins } from "../context/ChatPluginsContext";
import {
  answerMessage,
  clearSignInPending,
  conversationReturnPath,
  isSignInPending,
  markSignInPending,
  personalPluginNamed,
  pluginAccountLabel,
  USE_HERE_NOTE,
} from "../lib/plugin-request";
import { pluginConnected, shellPath } from "../lib/plugins";
import { ConnectorIcon } from "./connectors/ConnectorIcon";
import { startPluginSignIn } from "./connectors/personal-connector";
import { Button } from "./ui/button";

type Answer = "use" | "not_now";
/** How a card action ended: it left for a sign-in, or it is done here. */
type Outcome = "redirected" | "done";

/**
 * The agent asked the person to turn on one of their own plugins in the chat's
 * workspace (`nb__manage_tools` `request_plugin`, ADR-0069 "Only the owner
 * grants"). The card asks the question the Plugins page asks; "Use here" makes
 * the same first-party `grant_connector` call, and either answer goes to the
 * agent as the person's next message.
 *
 * Use here follows the Plugins page's rule, that the button is the next step.
 * A plugin with no account behind it is turned on and then signed in to, and
 * the sign-in returns to this conversation; the answer goes once the person is
 * back with it connected, never before they leave, since they may abandon the
 * sign-in (`markSignInPending`). A plugin already on here but not signed in
 * offers Connect, which does the same.
 *
 * Everything shown comes from the caller's own plugin listing, not from the
 * call: a name that is not one of their plugins renders nothing. The workspace
 * is the chat's own. Only the latest message's card takes an answer, and only
 * once the turn has stopped; an older one states where things stand.
 */
export function PluginRequestCard({
  serverName,
  isLatestMessage,
}: {
  serverName: string;
  isLatestMessage: boolean;
}) {
  const plugin = personalPluginNamed(useChatPlugins(), serverName);
  if (!plugin) return null;
  return <RequestCard plugin={plugin} serverName={serverName} isLatestMessage={isLatestMessage} />;
}

function RequestCard({
  plugin,
  serverName,
  isLatestMessage,
}: {
  plugin: Plugin;
  serverName: string;
  isLatestMessage: boolean;
}) {
  const chat = useChatAnswer();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = useRef(false);

  const connected = pluginConnected(plugin);
  const conversationId = chat?.conversationId;
  const live = answer === null && isLatestMessage && chat?.canAnswer === true && !!chat.workspaceId;

  const sendAnswer = async (choice: Answer) => {
    if (!chat || answered.current) return;
    answered.current = true;
    clearSignInPending();
    setAnswer(choice);
    try {
      await chat.send(answerMessage(plugin.displayName, choice), { serverName, answer: choice });
    } catch (err) {
      answered.current = false;
      setAnswer(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Back from the sign-in this card started, with the plugin connected: answer.
  const returnedSignedIn =
    live &&
    plugin.granted &&
    connected &&
    !!conversationId &&
    isSignInPending(conversationId, serverName);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `returnedSignedIn` is the trigger; `sendAnswer` sends at most once
  useEffect(() => {
    if (returnedSignedIn) void sendAnswer("use");
  }, [returnedSignedIn]);

  // Run one of the card's actions: busy while it runs, its failure shown. An
  // action that left for a sign-in keeps the card busy until the page goes.
  const run = async (action: () => Promise<Outcome>) => {
    setBusy(true);
    setError(null);
    try {
      if ((await action()) === "redirected") return;
    } catch (err) {
      clearSignInPending();
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  // Sign in to the plugin, coming back to this conversation, then answer. The
  // answer goes now when it connected without leaving; otherwise it waits for
  // the return.
  const signInThenAnswer = async (): Promise<Outcome> => {
    const { connectors } = await listPersonalConnectors();
    if (conversationId) markSignInPending(conversationId, serverName);
    const returnTo = conversationId
      ? conversationReturnPath(window.location.pathname, conversationId)
      : shellPath();
    if ((await startPluginSignIn(plugin, connectors, returnTo)) === "redirected") {
      return "redirected";
    }
    await sendAnswer("use");
    return "done";
  };

  const answerNow = async (choice: Answer): Promise<Outcome> => {
    await sendAnswer(choice);
    return "done";
  };

  const turnOnHere = () =>
    run(async () => {
      const wsId = chat?.workspaceId;
      if (!wsId) return "done";
      for (const server of plugin.servers) await grantConnector(server.serverName, wsId);
      return connected ? answerNow("use") : signInThenAnswer();
    });

  const account = pluginAccountLabel(plugin);
  const workspaceName = chat?.workspaceName ?? "this workspace";
  const question = `Use ${plugin.displayName}${account ? ` (${account})` : ""} in ${workspaceName}?`;

  return (
    <fieldset
      data-testid="plugin-request"
      className="min-w-0 rounded-sm border border-border bg-muted/40 px-3 py-2.5 text-sm"
    >
      <legend className="sr-only">Plugin request</legend>
      <div className="flex items-center gap-2">
        <ConnectorIcon
          name={plugin.displayName}
          iconUrl={plugin.iconUrl}
          className="h-5 w-5 rounded text-[10px]"
        />
        <p className="font-medium">{question}</p>
      </div>
      <RequestStatus plugin={plugin} answer={answer} />
      {error && <p className="mt-1 text-destructive">{error}</p>}
      {live && !plugin.granted && (
        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void turnOnHere()}
            data-testid="plugin-request-use"
          >
            {busy ? "Turning on…" : "Use here"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => answerNow("not_now"))}
            data-testid="plugin-request-not-now"
          >
            Not now
          </Button>
        </div>
      )}
      {live && plugin.granted && !connected && (
        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void run(signInThenAnswer)}
            data-testid="plugin-request-connect"
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/** Where the request stands, under the question. */
function RequestStatus({ plugin, answer }: { plugin: Plugin; answer: Answer | null }) {
  const connected = pluginConnected(plugin);
  const on = plugin.granted || answer === "use";
  if (!on && answer !== "not_now") {
    return (
      <p className="mt-1 text-muted-foreground">
        {USE_HERE_NOTE}
        {!connected && ` You'll sign in to ${plugin.displayName} next.`}
      </p>
    );
  }
  const status = !on
    ? "Not turned on."
    : connected
      ? "Turned on here."
      : `On here. Sign in to ${plugin.displayName} to finish.`;
  return (
    <p className="mt-1 text-muted-foreground" data-testid="plugin-request-status">
      {status}
    </p>
  );
}

/**
 * The person's answer to a plugin request card, in the place of the message
 * that carried it to the agent. The card marks that message when it sends it
 * (`pluginRequestAnswer`), so a message the person typed with the same words
 * stays an ordinary bubble.
 */
export function PluginRequestAnswerLine({ answer }: { answer: PluginRequestAnswer }) {
  const plugins = useChatPlugins();
  const name = personalPluginNamed(plugins, answer.serverName)?.displayName ?? "the plugin";
  return (
    <p
      data-testid="plugin-request-answer"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      {answer.answer === "use" ? (
        <>
          <Check aria-hidden className="h-3.5 w-3.5" />
          You turned on {name} here
        </>
      ) : (
        <>You chose not now for {name}</>
      )}
    </p>
  );
}
