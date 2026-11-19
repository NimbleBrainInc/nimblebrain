import { Check } from "lucide-react";
import { useState } from "react";
import type { PluginRequestAnswer } from "../_generated/platform-schemas/plugins";
import { grantConnector } from "../api/client";
import { useChatAnswer } from "../context/ChatAnswerContext";
import { useChatPlugins } from "../context/ChatPluginsContext";
import {
  answerMessage,
  personalPluginNamed,
  pluginAccountLabel,
  USE_HERE_NOTE,
} from "../lib/plugin-request";
import { ConnectorIcon } from "./connectors/ConnectorIcon";
import { Button } from "./ui/button";

type Answer = "use" | "not_now";

/**
 * The agent asked the person to turn on one of their own plugins in the chat's
 * workspace (`nb__manage_tools` `request_plugin`, ADR-0069 "Only the owner
 * grants"). The card asks the question the Plugins page asks; "Use here" makes
 * the same first-party `grant_connector` call, and either answer goes to the
 * agent as the person's next message.
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
  const plugins = useChatPlugins();
  const chat = useChatAnswer();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plugin = personalPluginNamed(plugins, serverName);
  if (!plugin) return null;

  const account = pluginAccountLabel(plugin);
  const workspaceName = chat?.workspaceName ?? "this workspace";
  const question = `Use ${plugin.displayName}${account ? ` (${account})` : ""} in ${workspaceName}?`;
  const on = plugin.granted || answer === "use";
  const canAnswer =
    !on && answer === null && isLatestMessage && chat?.canAnswer === true && !!chat.workspaceId;

  const respond = async (choice: Answer) => {
    const wsId = chat?.workspaceId;
    if (!chat || !wsId) return;
    setBusy(true);
    setError(null);
    try {
      if (choice === "use") {
        for (const server of plugin.servers) await grantConnector(server.serverName, wsId);
      }
      setAnswer(choice);
      await chat.send(answerMessage(plugin.displayName, choice), { serverName, answer: choice });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
      {on ? (
        <p className="mt-1 text-muted-foreground" data-testid="plugin-request-status">
          Turned on here.
        </p>
      ) : answer === "not_now" ? (
        <p className="mt-1 text-muted-foreground" data-testid="plugin-request-status">
          Not turned on.
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">{USE_HERE_NOTE}</p>
      )}
      {error && <p className="mt-1 text-destructive">{error}</p>}
      {canAnswer && (
        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void respond("use")}
            data-testid="plugin-request-use"
          >
            {busy ? "Turning on…" : "Use here"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void respond("not_now")}
            data-testid="plugin-request-not-now"
          >
            Not now
          </Button>
        </div>
      )}
    </fieldset>
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
