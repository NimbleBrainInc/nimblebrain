export function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="loading-list">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable skeleton placeholders
        <div key={i} className="skel skel-card" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="loading-list">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable skeleton placeholders
        <div key={i} className="skel skel-row" />
      ))}
    </div>
  );
}
