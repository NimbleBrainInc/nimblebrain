export function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="loading-list">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders carry no data; their count is all that changes
        <div key={i} className="skel skel-card" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="loading-list">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders carry no data; their count is all that changes
        <div key={i} className="skel skel-row" />
      ))}
    </div>
  );
}
