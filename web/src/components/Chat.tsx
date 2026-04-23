import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useChatContext } from "../context/ChatContext";
import { ChatPanel } from "./ChatPanel";

export function Chat() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const {
    messages,
    isStreaming,
    conversationId,
    error,
    sendMessage,
    newConversation,
    loadConversation,
    retryLastMessage,
  } = useChatContext();

  useEffect(() => {
    if (id) {
      loadConversation(id);
    }
  }, [id, loadConversation]);

  useEffect(() => {
    if (conversationId && conversationId !== id) {
      navigate(`/chat/${conversationId}`, { replace: true });
    }
  }, [conversationId, id, navigate]);

  const handleNewConversation = useCallback(() => {
    newConversation();
    navigate("/chat", { replace: true });
  }, [newConversation, navigate]);

  const handleSendMessage = useCallback(
    (text: string, files?: File[]) => {
      return sendMessage(text, undefined, files);
    },
    [sendMessage],
  );

  return (
    <ChatPanel
      messages={messages}
      isStreaming={isStreaming}
      error={error}
      sendMessage={handleSendMessage}
      newConversation={handleNewConversation}
      compact={false}
      onRetry={retryLastMessage}
    />
  );
}
