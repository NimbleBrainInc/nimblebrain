import { useEffect, useMemo, useState } from "react";
import { toPickerModels } from "../components/ModelPicker";
import { useChatConfigContext, useChatContext } from "../context/ChatContext";

/**
 * What a composer's model control states and offers, for the panel's open
 * conversation. Every composer that sends into that conversation (the chat
 * panel's, the overview's) reads it here, so they agree on what a send would
 * use. The pre-send choice is each composer's own.
 */
export function useComposerModel() {
  const { conversationId, conversationMeta } = useChatContext();
  const { availableModels, newConversationModel, runsOn } = useChatConfigContext();
  const all = useMemo(() => toPickerModels(availableModels), [availableModels]);
  const [pendingModel, setPendingModel] = useState<string | undefined>(undefined);

  // Cleared once a conversation exists, because the binding is then what the
  // control states and a leftover choice would contradict it. Deliberately not
  // cleared when the id goes null: that is a fresh conversation, and the
  // bound-state menu starts one precisely so a chosen model can carry into it.
  useEffect(() => {
    if (conversationId) setPendingModel(undefined);
  }, [conversationId]);

  const boundModel = conversationId ? conversationMeta?.model : undefined;
  // A conversation created before the binding existed carries no model, and
  // the runtime resolves its turns from current config instead — which means a
  // model named here would actually take effect on it, mid-conversation. There
  // is nothing true for the control to state and nothing safe for it to offer,
  // so it shows nothing.
  const bindingUnknown = Boolean(conversationId) && !boundModel;

  return {
    // A runtime that brings its own model uses none of these, so none is offered.
    models: bindingUnknown || runsOn ? [] : all,
    runsOn,
    boundModel,
    defaultModel: newConversationModel,
    pendingModel,
    setPendingModel,
  };
}
