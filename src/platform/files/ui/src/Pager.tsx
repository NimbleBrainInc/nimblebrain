import { PAGE_SIZE } from "./useFileList";

/** "51–100 of 300 files" and the controls to step through the pages. */
export function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (total === 0) return null;
  const first = page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <nav className="pager" aria-label="Pages">
      <span className="pager-range">
        {first}–{last} of {total} file{total === 1 ? "" : "s"}
      </span>
      {pageCount > 1 && (
        <span className="pager-controls">
          <button
            type="button"
            className="pager-btn"
            disabled={page === 0}
            onClick={() => onPage(0)}
            aria-label="First page"
          >
            «
          </button>
          <button
            type="button"
            className="pager-btn"
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
            aria-label="Previous page"
          >
            ‹ Prev
          </button>
          <span className="pager-page">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="pager-btn"
            disabled={page >= pageCount - 1}
            onClick={() => onPage(page + 1)}
            aria-label="Next page"
          >
            Next ›
          </button>
          <button
            type="button"
            className="pager-btn"
            disabled={page >= pageCount - 1}
            onClick={() => onPage(pageCount - 1)}
            aria-label="Last page"
          >
            »
          </button>
        </span>
      )}
    </nav>
  );
}
