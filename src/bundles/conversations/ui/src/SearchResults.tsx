import type { ReactNode } from "react";
import type { SearchResultData } from "./types";

const SKELETON_KEYS = ["s1", "s2", "s3", "s4"] as const;

interface Props {
  loading: boolean;
  results: SearchResultData | null;
  query: string;
  onOpen: (id: string) => void;
}

// Highlight every case-insensitive occurrence of `query` inside `text`.
// Returns interleaved <span>/<mark> nodes so React can key them stably.
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const out: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(qLower, cursor);
    if (idx === -1) {
      out.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(<mark key={idx}>{text.slice(idx, idx + qLower.length)}</mark>);
    cursor = idx + qLower.length;
  }
  return out;
}

export function SearchResults({ loading, results, query, onOpen }: Props) {
  if (loading) {
    return (
      <div className="loading-skels">
        {SKELETON_KEYS.map((k) => (
          <div key={k} className="skel skel-card" />
        ))}
      </div>
    );
  }

  if (!results) return null;

  const hits = results.results;

  return (
    <>
      <div className="search-results-count">
        {hits.length} result{hits.length === 1 ? "" : "s"} for “{query}”
      </div>
      {hits.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">Nothing found</div>
          <div className="empty-state-desc">No conversations match “{query}”</div>
        </div>
      ) : (
        hits.map((r) => (
          <button type="button" key={r.id} className="search-result" onClick={() => onOpen(r.id)}>
            <div className="search-result-title">{r.title || r.id}</div>
            {r.matches?.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: match snippets within a result have no stable id
              <div key={i} className="search-result-snippet">
                {highlight(m.snippet, query)}
              </div>
            ))}
          </button>
        ))
      )}
    </>
  );
}
