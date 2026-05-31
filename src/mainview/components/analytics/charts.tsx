/**
 * Lightweight SVG chart primitives — no external dependencies.
 */
import { useState } from "react";

// ── Shared hover tooltip ──────────────────────────────────────────────────────

interface HoverTooltip {
  x: number;
  y: number;
  text: string;
}

function ChartTooltip({ tip }: { tip: HoverTooltip | null }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-xl bg-gray-950 px-3 py-2 text-sm text-white shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ left: tip.x + 12, top: tip.y - 8 }}
    >
      {tip.text}
    </div>
  );
}

// ── Line Chart ────────────────────────────────────────────────────────────────

interface LineChartProps {
  data: Array<{ label: string; value: number }>;
  color?: string;
  height?: number;
  showDots?: boolean;
}

export function LineChart({ data, color = "#6366f1", height = 120, showDots = true }: LineChartProps) {
  const [tip, setTip] = useState<HoverTooltip | null>(null);

  if (data.length === 0) return <EmptyChart height={height} />;

  const w = 500;
  const h = height;
  const pad = { top: 8, right: 8, bottom: 24, left: 32 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);

  // Pad single-point datasets with a leading zero so a line can be drawn
  const chartData = data.length === 1 ? [{ label: "", value: 0 }, ...data] : data;
  const xStep = innerW / Math.max(chartData.length - 1, 1);

  const pts = chartData.map((d, i) => ({
    x: pad.left + i * xStep,
    y: pad.top + innerH - (d.value / maxVal) * innerH,
    label: d.label,
    value: d.value,
  }));

  const pathD = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const fillD = `${pathD} L ${pts[pts.length - 1].x} ${pad.top + innerH} L ${pts[0].x} ${pad.top + innerH} Z`;

  // Y-axis labels
  const yLabels = [0, Math.round(maxVal / 2), maxVal];

  // X-axis: show every nth label to avoid crowding
  const showEvery = Math.ceil(data.length / 6);

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
        {/* Grid lines */}
        {yLabels.map((v, i) => {
          const y = pad.top + innerH - (v / maxVal) * innerH;
          return (
            <g key={i}>
              <line x1={pad.left} x2={w - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
              <text x={pad.left - 4} y={y + 4} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.4}>{v}</text>
            </g>
          );
        })}
        {/* Fill */}
        <path d={fillD} fill={color} fillOpacity={0.1} />
        {/* Line */}
        <path d={pathD} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {/* Dots & x labels */}
        {pts.map((p, i) => (
          <g key={i}>
            {showDots && (
              <circle
                cx={p.x} cy={p.y} r={3} fill={color} stroke="white" strokeWidth={1.5}
                className="cursor-default"
                onMouseMove={(e) => p.label && setTip({ x: e.clientX, y: e.clientY, text: `${p.label}: ${p.value}` })}
                onMouseLeave={() => setTip(null)}
              />
            )}
            {i % showEvery === 0 && (
              <text x={p.x} y={h - 4} textAnchor="middle" fontSize={8} fill="currentColor" opacity={0.4}>
                {p.label.slice(-5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <ChartTooltip tip={tip} />
    </div>
  );
}

// ── Bar Chart ─────────────────────────────────────────────────────────────────

interface BarChartProps {
  data: Array<{ label: string; value: number; color?: string }>;
  height?: number;
  horizontal?: boolean;
}

export function BarChart({ data, height = 160, horizontal = false }: BarChartProps) {
  const [tip, setTip] = useState<HoverTooltip | null>(null);

  if (data.length === 0) return <EmptyChart height={height} />;

  const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4"];
  const w = 500;
  const h = height;
  const pad = { top: 8, right: 8, bottom: 28, left: 36 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  const maxVal = Math.max(...data.map((d) => d.value), 1);

  if (horizontal) {
    const barH = Math.min(20, (innerH / data.length) - 4);
    const gap = (innerH - barH * data.length) / Math.max(data.length - 1, 1);
    return (
      <div className="relative" onMouseLeave={() => setTip(null)}>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
          {data.map((d, i) => {
            const color = d.color ?? COLORS[i % COLORS.length];
            const barW = (d.value / maxVal) * innerW;
            const y = pad.top + i * (barH + gap);
            return (
              <g key={i}>
                <text x={pad.left - 4} y={y + barH / 2 + 4} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6} className="truncate">
                  {d.label.slice(0, 12)}
                </text>
                <rect
                  x={pad.left} y={y} width={barW} height={barH} rx={3} fill={color} fillOpacity={0.85}
                  className="cursor-default"
                  onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: `${d.label}: ${d.value}` })}
                  onMouseLeave={() => setTip(null)}
                />
                <text x={pad.left + barW + 4} y={y + barH / 2 + 4} fontSize={9} fill="currentColor" opacity={0.6}>
                  {d.value}
                </text>
              </g>
            );
          })}
        </svg>
        <ChartTooltip tip={tip} />
      </div>
    );
  }

  const barW = Math.max(4, innerW / data.length - 4);
  const gap = (innerW - barW * data.length) / Math.max(data.length - 1, 1);

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + innerH} stroke="currentColor" strokeOpacity={0.15} />
        <line x1={pad.left} x2={w - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="currentColor" strokeOpacity={0.15} />
        {data.map((d, i) => {
          const color = d.color ?? COLORS[i % COLORS.length];
          const barH = (d.value / maxVal) * innerH;
          const x = pad.left + i * (barW + gap);
          const y = pad.top + innerH - barH;
          return (
            <g key={i}>
              <rect
                x={x} y={y} width={barW} height={barH} rx={2} fill={color} fillOpacity={0.85}
                className="cursor-default"
                onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: `${d.label}: ${d.value}` })}
                onMouseLeave={() => setTip(null)}
              />
              <text x={x + barW / 2} y={pad.top + innerH + 12} textAnchor="middle" fontSize={8} fill="currentColor" opacity={0.5}>
                {d.label.slice(0, 6)}
              </text>
            </g>
          );
        })}
        <text x={pad.left - 4} y={pad.top + 4} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.4}>{maxVal}</text>
        <text x={pad.left - 4} y={pad.top + innerH / 2 + 4} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.4}>{Math.round(maxVal / 2)}</text>
      </svg>
      <ChartTooltip tip={tip} />
    </div>
  );
}

// ── Donut Chart ───────────────────────────────────────────────────────────────

interface DonutChartProps {
  data: Array<{ label: string; value: number; color?: string }>;
  size?: number;
}

const DONUT_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#f87171"];

function computeSlices(data: DonutChartProps["data"], total: number) {
  let cum = 0;
  return data.map((d, i) => {
    const start = (cum / total) * 2 * Math.PI - Math.PI / 2;
    cum += d.value;
    const end = (cum / total) * 2 * Math.PI - Math.PI / 2;
    const color = d.color ?? DONUT_COLORS[i % DONUT_COLORS.length];
    return { start, end, color, label: d.label, value: d.value, pct: Math.round((d.value / total) * 100) };
  });
}

export function DonutChart({ data, size = 120 }: DonutChartProps) {
  const [tip, setTip] = useState<HoverTooltip | null>(null);

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <EmptyChart height={size} />;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const innerR = size * 0.22;

  const slices = computeSlices(data, total);

  function arcPath(start: number, end: number, outerR: number, innerR2: number): string {
    const x1 = cx + outerR * Math.cos(start);
    const y1 = cy + outerR * Math.sin(start);
    const x2 = cx + outerR * Math.cos(end);
    const y2 = cy + outerR * Math.sin(end);
    const x3 = cx + innerR2 * Math.cos(end);
    const y3 = cy + innerR2 * Math.sin(end);
    const x4 = cx + innerR2 * Math.cos(start);
    const y4 = cy + innerR2 * Math.sin(start);
    const large = end - start > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR2} ${innerR2} 0 ${large} 0 ${x4} ${y4} Z`;
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" onMouseLeave={() => setTip(null)}>
        <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
          {slices.map((s, i) => (
            <path
              key={i}
              d={arcPath(s.start, s.end, r, innerR)}
              fill={s.color}
              fillOpacity={0.9}
              stroke="white"
              strokeWidth={1}
              className="cursor-default"
              onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: `${s.label}: ${s.value} (${s.pct}%)` })}
              onMouseLeave={() => setTip(null)}
            />
          ))}
          <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight="600" fill="currentColor">{total}</text>
        </svg>
        <ChartTooltip tip={tip} />
      </div>
      <div className="space-y-1 min-w-0">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="truncate text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-medium shrink-0">{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Activity Heatmap ──────────────────────────────────────────────────────────

interface HeatmapProps {
  data: Array<{ dow: number; hour: number; count: number }>;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityHeatmap({ data }: HeatmapProps) {
  const [tip, setTip] = useState<HoverTooltip | null>(null);

  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const grid = Array.from({ length: 7 }, (_, dow) =>
    Array.from({ length: 24 }, (_, hour) => {
      const found = data.find((d) => d.dow === dow && d.hour === hour);
      return found?.count ?? 0;
    }),
  );

  const cellW = 14;
  const cellH = 5;
  const gap = 1;
  const labelW = 28;
  const labelH = 16;
  const totalW = labelW + 24 * (cellW + gap);
  const totalH = labelH + 7 * (cellH + gap);

  const showHour = (h: number) => h % 6 === 0;

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${totalW} ${totalH}`} className="w-full">
        {/* Hour labels */}
        {Array.from({ length: 24 }, (_, h) => showHour(h) && (
          <text key={h} x={labelW + h * (cellW + gap) + cellW / 2} y={labelH - 3} textAnchor="middle" fontSize={4} fill="currentColor" opacity={0.4}>
            {h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`}
          </text>
        ))}
        {grid.map((hours, dow) => (
          <g key={dow}>
            <text x={labelW - 3} y={labelH + dow * (cellH + gap) + cellH / 2} textAnchor="end" dominantBaseline="middle" fontSize={3} fill="currentColor" opacity={0.4}>
              {DAYS[dow]}
            </text>
            {hours.map((count, hour) => {
              const intensity = count / maxCount;
              const opacity = count === 0 ? 0.06 : 0.15 + intensity * 0.85;
              return (
                <rect
                  key={hour}
                  x={labelW + hour * (cellW + gap)}
                  y={labelH + dow * (cellH + gap)}
                  width={cellW}
                  height={cellH}
                  rx={2}
                  fill="#6366f1"
                  fillOpacity={opacity}
                  className="cursor-default"
                  onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: `${DAYS[dow]} ${hour}:00 — ${count} events` })}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
          </g>
        ))}
      </svg>
      <ChartTooltip tip={tip} />
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}

export function StatCard({ label, value, sub, accent = "text-foreground" }: StatCardProps) {
  return (
    <div className="border rounded-lg p-4 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${accent}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted-foreground border border-dashed rounded" style={{ height }}>
      No data
    </div>
  );
}
