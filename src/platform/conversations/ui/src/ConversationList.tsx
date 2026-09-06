import { FILTER_GROUPS, relativeTime, truncate } from "./dateUtils";
import type { DateGroup, FilterKey } from "./types";

// Stable keys for skeleton placeholders. Length is fixed and order never
// changes, so a static array is the cheapest way to satisfy noArrayIndexKey.
const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

interface Props {
  loading: boolean;
  groups: DateGroup[];
  activeFilter: FilterKey;
  totalConversations: number;
  /** Conversation ids with an in-flight assistant turn (host-pushed). */
  streamingIds?: Set<string>;
  onOpen: (id: string) => void;
}

export function ConversationList({
  loading,
  groups,
  activeFilter,
  totalConversations,
  streamingIds,
  onOpen,
}: Props) {
  if (loading) {
    return (
      <div className="loading-skels">
        {SKELETON_KEYS.map((k) => (
          <div key={k} className="skel skel-card" />
        ))}
      </div>
    );
  }

  if (totalConversations === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">What would you like to explore?</div>
        <div className="empty-state-desc">Start a conversation to see your history here.</div>
      </div>
    );
  }

  const indices = FILTER_GROUPS[activeFilter];
  const showSectionLabels = indices.length > 1;
  const visibleGroups = indices
    .map((idx) => groups[idx])
    .filter((g): g is DateGroup => Boolean(g) && g.items.length > 0);

  if (visibleGroups.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-desc">No conversations in this period.</div>
      </div>
    );
  }

  return (
    <>
      {visibleGroups.map((group) => (
        <div key={group.label}>
          {showSectionLabels && <div className="section-label">{group.label}</div>}
          {group.items.map((c) => {
            const title = c.title || c.preview || c.id;
            const isStreaming = streamingIds?.has(c.id) ?? false;
            return (
              <button type="button" key={c.id} className="conv-item" onClick={() => onOpen(c.id)}>
                <div className="conv-item-top">
                  <span className="conv-title">
                    {isStreaming && (
                      <span
                        className="conv-streaming-dot"
                        role="img"
                        aria-label="Responding"
                        title="Responding…"
                      />
                    )}
                    {truncate(title, 80)}
                  </span>
                  <span className="conv-time">{relativeTime(c.updatedAt || c.createdAt)}</span>
                </div>
                {c.preview && <div className="conv-preview">{truncate(c.preview, 120)}</div>}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
