import { useState } from "react";

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

interface DayData {
  key: string;
  cost: CostBreakdown;
  llmCalls: number;
}

interface CostChartProps {
  data: DayData[];
}

// Colors — muted palette that works on light backgrounds
const COLORS = {
  input: "#6366f1", // indigo
  output: "#f59e0b", // amber
  cacheRead: "#10b981", // emerald
  cacheCreation: "#8b5cf6", // violet
};

const LABELS: Record<string, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheCreation: "Cache write",
};

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) return `$${(n * 100).toFixed(2)}c`;
  return `$${n.toFixed(4)}`;
}

export function CostChart({ data }: CostChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }

  // Chart dimensions
  const width = 700;
  const height = 200;
  const paddingLeft = 50;
  const paddingRight = 16;
  const paddingTop = 12;
  const paddingBottom = 28;
  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  // Scale
  const maxCost = Math.max(...data.map((d) => d.cost.total), 0.001);
  const barWidth = Math.min(Math.floor(chartWidth / data.length) - 2, 40);
  const gap = (chartWidth - barWidth * data.length) / (data.length + 1);

  // Y-axis ticks
  const yTicks = 4;
  const yStep = maxCost / yTicks;

  const segments: Array<{ key: keyof typeof COLORS; field: keyof CostBreakdown }> = [
    { key: "cacheCreation", field: "cacheCreation" },
    { key: "cacheRead", field: "cacheRead" },
    { key: "output", field: "output" },
    { key: "input", field: "input" },
  ];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: 220 }}
        aria-hidden="true"
      >
        {/* Y-axis gridlines + labels */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const value = yStep * i;
          const y = paddingTop + chartHeight - (value / maxCost) * chartHeight;
          return (
            <g key={`y-${value}`}>
              <line
                x1={paddingLeft}
                x2={width - paddingRight}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <text
                x={paddingLeft - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                ${value < 0.01 ? value.toFixed(3) : value.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((d, i) => {
          const x = paddingLeft + gap + i * (barWidth + gap);
          let yOffset = 0;

          // biome-ignore lint/a11y/noStaticElementInteractions: SVG hover for tooltip, no keyboard equivalent needed
          return (
            <g
              key={d.key}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              style={{ cursor: "default" }}
            >
              {/* Invisible hit area for hover */}
              <rect
                x={x - 2}
                y={paddingTop}
                width={barWidth + 4}
                height={chartHeight}
                fill="transparent"
              />

              {/* Stacked segments (bottom to top: input, output, cacheRead, cacheCreation) */}
              {segments.map(({ key, field }) => {
                const value = d.cost[field] as number;
                if (value <= 0) return null;
                const segHeight = (value / maxCost) * chartHeight;
                const segY = paddingTop + chartHeight - yOffset - segHeight;
                yOffset += segHeight;
                return (
                  <rect
                    key={key}
                    x={x}
                    y={segY}
                    width={barWidth}
                    height={Math.max(segHeight, 0.5)}
                    fill={COLORS[key]}
                    rx={segHeight === yOffset ? 2 : 0}
                    opacity={hoveredIndex === null || hoveredIndex === i ? 1 : 0.3}
                  />
                );
              })}

              {/* X-axis label */}
              <text
                x={x + barWidth / 2}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 10 }}
              >
                {formatShortDate(d.key)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && data[hoveredIndex] && (
        <div
          className="absolute bg-popover border border-border rounded-md shadow-md px-3 py-2 text-xs pointer-events-none z-10"
          style={{
            left: `${((paddingLeft + gap + hoveredIndex * (barWidth + gap) + barWidth / 2) / width) * 100}%`,
            top: 0,
            transform: "translate(-50%, 0)",
            minWidth: 140,
          }}
        >
          <div className="font-medium mb-1">{formatShortDate(data[hoveredIndex].key)}</div>
          {segments
            .filter(({ field }) => (data[hoveredIndex]!.cost[field] as number) > 0)
            .map(({ key, field }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: COLORS[key] }}
                  />
                  {LABELS[key]}
                </span>
                <span className="font-mono">
                  {formatUsd(data[hoveredIndex]!.cost[field] as number)}
                </span>
              </div>
            ))}
          <div className="flex justify-between border-t border-border mt-1 pt-1 font-medium">
            <span>Total</span>
            <span className="font-mono">{formatUsd(data[hoveredIndex].cost.total)}</span>
          </div>
          <div className="text-muted-foreground mt-0.5">{data[hoveredIndex].llmCalls} calls</div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-2 text-xs text-muted-foreground">
        {Object.entries(COLORS).map(([key, color]) => (
          <span key={key} className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {LABELS[key]}
          </span>
        ))}
      </div>
    </div>
  );
}
