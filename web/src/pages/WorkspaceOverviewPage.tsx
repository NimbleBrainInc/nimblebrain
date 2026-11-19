// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — workspace landing at `/w/<slug>/`
//
// Answers "what do I do here?" with two things:
//   1. Ask: a composer. A question sent here opens the chat over the whole main
//      area, since a conversation started from the overview is the work, not a
//      side panel beside it.
//   2. Next steps: a few cards, ranked by `overviewActions`: what needs a member
//      (alerts), then the workspace's next setup step, then the last
//      conversation. A brand-new workspace gets setup cards; a busy one gets its
//      alerts.
// Apps, conversations, and settings are one click away in the sidebar and the
// workspace menu, so the page does not repeat them.
//
// Gutter: the content's edges sit on the top bar's (`pl-4 pr-3` in TopBar), so
// the title lines up under the bar's title. Nothing is centered, since
// centering moves content off those lines as the main area widens. Widths come
// from container queries on the main area (web/DESIGN.md), never the viewport.
// ---------------------------------------------------------------------------

import { ArrowUp } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ActionCards } from "../components/overview/ActionCards";
import { type OverviewAction, overviewActions } from "../components/overview/actions";
import { Tooltip } from "../components/ui/tooltip";
import { useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSession } from "../context/SessionContext";
import { useWorkspaceAppIcons } from "../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useRecentConversations } from "../hooks/useRecentConversations";
import { useRunsNeedingReview } from "../hooks/useRunsNeedingReview";
import { canManageWorkspaceMembers, canWriteWorkspace } from "../hooks/useScopedRole";
import { useWorkspaceBriefing } from "../hooks/useWorkspaceBriefing";
import { toSlug } from "../lib/workspace-slug";

export function WorkspaceOverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const wsCtx = useWorkspaceContext();
  const { connectors } = useWorkspaceAppIcons();
  const navigate = useNavigate();
  const session = useSession();
  const chat = useChatContext();
  const { openFullscreen } = useChatPanelContext();

  const workspace = slug ? wsCtx.workspaces.find((w) => toSlug(w.id) === slug) : undefined;

  // Every read is keyed on THIS page's route workspace, so the reads and what
  // they render follow the URL in lockstep: no one-frame mismatch on a switch.
  const {
    briefing,
    loading: briefingLoading,
    error: briefingError,
    refresh: refreshBriefing,
  } = useWorkspaceBriefing(workspace?.id);
  const recent = useRecentConversations(workspace?.id, 1);
  const reviewCount = useRunsNeedingReview(workspace?.id);

  // Connector status comes from the list the app icons already fetch. Until it
  // names this workspace (a switch in flight), the cards wait for it, so a
  // connector needing attention never appears after the rest have settled.
  const connectorsReady = workspace != null && connectors?.workspaceId === workspace.id;

  /** Send a question and open the chat over the main area. */
  const ask = useCallback(
    (text: string) => {
      openFullscreen();
      void chat.sendMessage(text);
    },
    [openFullscreen, chat],
  );

  const choose = useCallback(
    (action: OverviewAction) => {
      const { target } = action;
      if (target.type === "navigate") navigate(target.to);
      else if (target.type === "conversation") openFullscreen(target.id);
      else if (target.type === "ask") ask(target.prompt);
    },
    [navigate, openFullscreen, ask],
  );

  if (!workspace) {
    return (
      <div
        className="px-(--page-gutter) py-8 text-sm text-muted-foreground"
        data-testid="workspace-overview-not-found"
      >
        Workspace not found.
      </div>
    );
  }

  // The cards render once every source has answered for this workspace, so
  // they appear once, in their final order, instead of reshuffling as each
  // read lands.
  const settled = connectorsReady && !briefingLoading && recent !== null && reviewCount !== null;
  const installed = connectorsReady ? connectors.installed : [];
  const actions = settled
    ? overviewActions({
        slug: toSlug(workspace.id),
        briefing,
        connectors: installed,
        reviewCount,
        setup: {
          connectPlugin: installed.length === 0 && canWriteWorkspace(workspace.userRole),
          firstQuestion: recent.length === 0,
          invite:
            workspace.memberCount === 1 &&
            canManageWorkspaceMembers(session?.user?.orgRole, workspace.userRole),
        },
        lastConversation: recent[0] ?? null,
      })
    : null;

  return (
    <div className="@container h-full overflow-y-auto" data-testid="workspace-overview-page">
      <div className="px-(--page-gutter) pt-8 pb-10">
        <h1 className="mb-6 truncate text-3xl font-heading font-medium text-foreground">
          {workspace.name}
        </h1>

        <AskComposer workspaceName={workspace.name} onAsk={ask} />

        {actions && (
          <ActionCards
            workspaceId={workspace.id}
            actions={actions}
            error={briefingError}
            onRetry={refreshBriefing}
            onChoose={choose}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Ask the workspace's agent. Its own component so typing and streaming
 * re-renders stay out of the page.
 */
function AskComposer({
  workspaceName,
  onAsk,
}: {
  workspaceName: string;
  onAsk: (text: string) => void;
}) {
  const chat = useChatContext();
  const [text, setText] = useState("");
  const ready = text.trim().length > 0 && !chat.isStreaming;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onAsk(text.trim());
    setText("");
  };

  return (
    <form
      onSubmit={submit}
      data-testid="workspace-overview-ask"
      data-tour="ask"
      className="mb-10 flex items-center gap-2 rounded-xl border border-border bg-card py-2 pl-5 pr-2 focus-within:border-foreground/20 transition-colors"
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Ask anything in ${workspaceName}`}
        placeholder={`Ask anything in ${workspaceName}…`}
        data-testid="workspace-overview-ask-input"
        className="min-w-0 flex-1 bg-transparent py-2 text-base text-foreground outline-none placeholder:text-muted-foreground"
      />
      <Tooltip label="Send">
        <button
          type="submit"
          aria-label="Send"
          disabled={!ready}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-foreground/10 disabled:text-muted-foreground transition-colors"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </form>
  );
}
