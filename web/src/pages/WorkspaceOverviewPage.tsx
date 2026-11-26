// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — workspace landing at `/w/<slug>/`
//
// A launcher: one centered column holding the composer and, under it, one list
// of next steps.
//   1. Ask: the chat's own composer (`MessageInput`), sending into the panel's
//      conversation. A question sent here opens the chat over the whole main
//      area, since a conversation started from the overview is the work, not a
//      side panel beside it.
//   2. Next steps: rows ranked by `overviewActions`: what needs a member
//      (alerts), then the workspace's next setup step, then the last
//      conversation, then conversation starters from the installed plugins.
// Apps, conversations, and settings are one click away in the sidebar and the
// workspace menu, so the page does not repeat them.
//
// The column is the full-screen chat's (`max-w-4xl` with `px-8`, as in
// ChatPanel), centered, so a send reads as the page turning into the
// conversation rather than a jump to another box. When the main area is wide,
// the column starts far enough down that the composer sits near the optical
// center (about 40% down a typical window), and the rows hang below it. The
// composer is placed, not the whole group centered: the rows arrive after the
// composer renders, and centering the group would move the composer under the
// pointer when they do. When the docked chat narrows the main area the column
// fills it; widths come from container queries on the main area
// (web/DESIGN.md), never the viewport.
// ---------------------------------------------------------------------------

import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MessageInput } from "../components/MessageInput";
import { ActionRows } from "../components/overview/ActionRows";
import { type OverviewAction, overviewActions } from "../components/overview/actions";
import { useChatConfigContext, useChatContext } from "../context/ChatContext";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSession } from "../context/SessionContext";
import { useWorkspaceAppIcons } from "../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useComposerModel } from "../hooks/useComposerModel";
import { useConversationStarters } from "../hooks/useConversationStarters";
import { useRecentConversations } from "../hooks/useRecentConversations";
import { useRunsNeedingReview } from "../hooks/useRunsNeedingReview";
import { canManageWorkspaceMembers, canWriteWorkspace } from "../hooks/useScopedRole";
import { useWorkspaceBriefing } from "../hooks/useWorkspaceBriefing";
import { toSlug } from "../lib/workspace-slug";

export function WorkspaceOverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const wsCtx = useWorkspaceContext();
  const { connectors, iconFor } = useWorkspaceAppIcons();
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
  // Not part of `settled` below: starters come last in the list, so they can
  // arrive after the rest without moving any row above them.
  const conversationStarters = useConversationStarters(workspace?.id);

  // Connector status comes from the list the app icons already fetch. Until it
  // names this workspace (a switch in flight), the cards wait for it, so a
  // connector needing attention never appears after the rest have settled.
  const connectorsReady = workspace != null && connectors?.workspaceId === workspace.id;

  /** Send a question and open the chat over the main area. */
  const ask = useCallback(
    (text: string, files?: File[], model?: string) => {
      openFullscreen();
      void chat.sendMessage(text, undefined, files, model);
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

  // The rows render once every source has answered for this workspace, so
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
        conversationStarters: conversationStarters ?? [],
        // The workspace and today's local date: the plugins whose starters
        // show change once a day, and stay put within it.
        starterRotation: `${workspace.id}:${localDay()}`,
      })
    : null;

  return (
    <div className="@container h-full overflow-y-auto" data-testid="workspace-overview-page">
      <div className="mx-auto w-full max-w-4xl px-8 pt-10 pb-12 @3xl:pt-[28vh]">
        <h1 className="mb-2 ml-1 truncate text-sm text-muted-foreground">
          Working in <span className="font-semibold text-foreground">{workspace.name}</span>
        </h1>

        <OverviewComposer workspaceName={workspace.name} onAsk={ask} />

        {actions && (
          <ActionRows
            iconFor={iconFor}
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
 * The chat's composer, on the overview. It edits and sends the panel's
 * conversation, as the docked panel's composer does, and states the same model.
 * Its own component so typing and streaming re-renders stay out of the page.
 */
function OverviewComposer({
  workspaceName,
  onAsk,
}: {
  workspaceName: string;
  onAsk: (text: string, files?: File[], model?: string) => void;
}) {
  const chat = useChatContext();
  const { fileLimits } = useChatConfigContext();
  const { models, runsOn, boundModel, defaultModel, pendingModel, setPendingModel } =
    useComposerModel();
  // A bound conversation's menu offers a new conversation on the chosen model.
  const { newConversation } = chat;
  const newConversationWithModel = useCallback(
    (model: string) => {
      newConversation();
      setPendingModel(model);
    },
    [newConversation, setPendingModel],
  );
  return (
    <div data-testid="workspace-overview-ask" data-tour="ask">
      <MessageInput
        conversationKey={chat.conversationKey}
        onSend={onAsk}
        busy={chat.isStreaming}
        models={models}
        runsOn={runsOn}
        boundModel={boundModel}
        defaultModel={defaultModel}
        pendingModel={pendingModel}
        onPendingModelChange={setPendingModel}
        onNewConversationWithModel={newConversationWithModel}
        fileLimits={fileLimits}
        placeholder="Ask anything, or pick something below…"
        label={`Ask anything in ${workspaceName}`}
        hints={false}
      />
    </div>
  );
}

/** Today's date in the viewer's own time zone, as `YYYY-MM-DD`. */
function localDay(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
