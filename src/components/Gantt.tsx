import { forwardRef, useEffect, useMemo, useRef } from 'react';
import type { GanttRow, ProjectDeveloper, SprintConfig } from '../types';
import { computeSprints, makeTimeline } from '../sprints';
import { computeVariance, clampPct } from '../variance';
import { formatDisplay, formatShort } from '../dates';

type Props = {
  sprintsConfig: SprintConfig;
  rows: GanttRow[];
  today: Date;
  present?: boolean;
  mode?: 'workstreams' | 'developers';
  developers?: ProjectDeveloper[];
};

// Geometry (intrinsic SVG pixels).
const PAD = 24;
const LABEL_MIN = 120; // label column min width
const LABEL_MAX = 320; // label column max width (longer names truncate)
const LABEL_RPAD = 16; // gap between a name and the first gridline
const MIN_COL_PX = 80; // minimum sprint column width (don't squish)
const PX_PER_DAY = 8; // column width ∝ real sprint length
const HEADER_H = 76;
const ROW_H = 46;
const BAR_H = 24;
const FOOTER_H = 22;

const LABEL_FONT =
  '500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

let measureCtx: CanvasRenderingContext2D | null = null;
function measureText(s: string): number {
  if (typeof document === 'undefined') return s.length * 7.5;
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7.5;
  measureCtx.font = LABEL_FONT;
  return measureCtx.measureText(s).width;
}

/** Truncate a string with an ellipsis so it fits maxPx (for SVG, which has no auto-ellipsis). */
function truncateToWidth(s: string, maxPx: number): string {
  if (measureText(s) <= maxPx) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(s.slice(0, mid) + '…') <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + '…';
}

const C = {
  boundary: '#e3eaf3',
  track: '#ffffff',
  trackStroke: '#cbd9ec',
  shade: '#2f6fb0',
  milestone: '#0c447c',
  behindTint: '#dce9f6',
  today: '#33475b',
  textPrimary: '#1e2a3a',
  textSecondary: '#5a6b80',
  pctOnShade: '#ffffff',
  pctOnTrack: '#1e2a3a',
  rowSep: '#eef2f8',
};

export const Gantt = forwardRef<SVGSVGElement, Props>(function Gantt(
  { sprintsConfig, rows, today, present = false, mode = 'workstreams', developers = [] },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const devMode = mode === 'developers';

  const { sprints, timeline } = useMemo(() => {
    const sprints = computeSprints(sprintsConfig);
    return { sprints, timeline: makeTimeline(sprints, { pxPerDay: PX_PER_DAY, minColPx: MIN_COL_PX }) };
  }, [sprintsConfig]);

  // Labels (and row count) come from whichever view is active.
  const labelNames = devMode ? developers.map((d) => d.name) : rows.map((r) => r.name);
  const rowCount = labelNames.length;

  // Size the label column to the widest name, capped; longer names truncate.
  const labelW = useMemo(() => {
    const widest = labelNames.reduce((m, name) => Math.max(m, measureText(name)), 0);
    return Math.min(LABEL_MAX, Math.max(LABEL_MIN, Math.ceil(widest) + LABEL_RPAD));
  }, [labelNames.join('')]);
  const labelTextW = labelW - LABEL_RPAD;

  const n = sprints.length;
  const trackLeft = PAD + labelW;
  const trackW = timeline.trackWidth;
  const width = trackLeft + trackW + PAD;
  const height = HEADER_H + Math.max(1, rowCount) * ROW_H + FOOTER_H;

  const fracToX = (frac: number) => trackLeft + frac * trackW;
  const todayX = fracToX(timeline.dateToFrac(today));
  const todayInRange = today >= sprints[0].start && today <= sprints[n - 1].boundaryEnd;
  const todayNearRight = todayX > width - 120;

  // On load (and when the project / mode changes), scroll the "today" line into view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || present || !todayInRange) return;
    el.scrollLeft = Math.max(0, todayX - trackLeft - 40);
  }, [sprintsConfig, present, todayX, trackLeft, todayInRange]);

  const svgStyle: React.CSSProperties = present
    ? { display: 'block', maxWidth: '100%', height: 'auto', fontFamily: 'inherit' }
    : { display: 'block', fontFamily: 'inherit' };

  return (
    <div className={`gantt${present ? ' present' : ''}`}>
      <div className="gantt-viewport" ref={scrollRef}>
        <svg
          ref={ref}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label="Tracking Gantt chart"
          style={svgStyle}
        >
          <rect x={0} y={0} width={width} height={height} fill="#ffffff" />

          {/* Sprint columns: gridlines + header labels. Column widths are
              proportional to each sprint's real length (from the timeline). */}
          {timeline.sprints.map((c) => {
            const x0 = fracToX(c.left);
            const cx = (x0 + fracToX(c.right)) / 2;
            return (
              <g key={c.index}>
                <line x1={x0} y1={HEADER_H - 18} x2={x0} y2={height - FOOTER_H} stroke={C.boundary} strokeWidth={1} />
                <text x={cx} y={36} textAnchor="middle" fontSize={14} fontWeight={600} fill={C.textPrimary}>
                  {`S${c.index}`}
                </text>
                <text x={cx} y={54} textAnchor="middle" fontSize={11} fill={C.textSecondary}>
                  {formatShort(c.finish)}
                </text>
              </g>
            );
          })}
          <line
            x1={trackLeft + trackW}
            y1={HEADER_H - 18}
            x2={trackLeft + trackW}
            y2={height - FOOTER_H}
            stroke={C.boundary}
            strokeWidth={1}
          />

          {/* Workstream rows */}
          {!devMode &&
            rows.map((row, idx) => {
            const y = HEADER_H + idx * ROW_H;
            const barY = y + (ROW_H - BAR_H) / 2;
            const unscheduled = row.sprintUnset === true;
            const start = Math.min(row.startSprint, row.endSprint);
            const end = Math.max(row.startSprint, row.endSprint);
            const barLeft = fracToX(timeline.columnLeft(start));
            const barRight = fracToX(timeline.columnRight(end));
            const barW = Math.max(2, barRight - barLeft);
            const endCol = timeline.sprints.find((c) => c.index === end);
            const v = computeVariance(row, timeline, today);
            const pct = clampPct(row.percentComplete);
            const shadedX = fracToX(v.shadedFrac);
            const shadedW = Math.max(0, shadedX - barLeft);
            const clipId = `clip-${row.id}`;
            const r = BAR_H / 2;
            const tint = v.status === 'behind' ? C.behindTint : 'transparent';
            const diamondR = BAR_H * 0.42;
            const pctLabel = `${pct}%`;
            const pctInside = shadedW > 30;

            return (
              <g key={row.id}>
                <title>
                  {unscheduled
                    ? `${row.name}\nUnscheduled — no sprint-assigned tasks${row.notes ? `\n${row.notes}` : ''}`
                    : `${row.name}\nCompletion: S${end} · ${formatDisplay(endCol?.finish ?? sprints[n - 1].finish)}\nProgress: ${pct}%${row.notes ? `\n${row.notes}` : ''}`}
                </title>

                {idx > 0 && (
                  <line x1={PAD} y1={y} x2={width - PAD} y2={y} stroke={C.rowSep} strokeWidth={1} />
                )}

                {/* Row name (truncated to fit; full name shown via the frozen overlay / title) */}
                <text
                  x={PAD}
                  y={y + ROW_H / 2}
                  dominantBaseline="middle"
                  fontSize={14}
                  fontWeight={500}
                  fill={C.textPrimary}
                >
                  {truncateToWidth(row.name, labelTextW)}
                </text>

                {unscheduled ? (
                  <text
                    x={trackLeft + 4}
                    y={y + ROW_H / 2}
                    dominantBaseline="middle"
                    fontSize={12}
                    fontStyle="italic"
                    fill={C.textSecondary}
                  >
                    Unscheduled
                  </text>
                ) : (
                  <>
                    <clipPath id={clipId}>
                      <rect x={barLeft} y={barY} width={barW} height={BAR_H} rx={r} ry={r} />
                    </clipPath>
                    <g clipPath={`url(#${clipId})`}>
                      <rect x={barLeft} y={barY} width={barW} height={BAR_H} fill={C.track} />
                      <rect x={shadedX} y={barY} width={Math.max(0, barRight - shadedX)} height={BAR_H} fill={tint} />
                      <rect x={barLeft} y={barY} width={shadedW} height={BAR_H} fill={C.shade} />
                    </g>
                    <rect
                      x={barLeft}
                      y={barY}
                      width={barW}
                      height={BAR_H}
                      rx={r}
                      ry={r}
                      fill="none"
                      stroke={C.trackStroke}
                      strokeWidth={1}
                    />

                    <text
                      x={pctInside ? shadedX - 6 : shadedX + 6}
                      y={y + ROW_H / 2}
                      dominantBaseline="middle"
                      textAnchor={pctInside ? 'end' : 'start'}
                      fontSize={12}
                      fontWeight={600}
                      fill={pctInside ? C.pctOnShade : C.pctOnTrack}
                    >
                      {pctLabel}
                    </text>

                    <path
                      d={diamond(barRight, barY + BAR_H / 2, diamondR)}
                      fill={C.milestone}
                      stroke="#ffffff"
                      strokeWidth={1.5}
                    />
                  </>
                )}
              </g>
            );
          })}

          {/* Developer rows: per-sprint utilization heatmap */}
          {devMode &&
            developers.map((dev, idx) => {
              const y = HEADER_H + idx * ROW_H;
              const cellY = y + (ROW_H - BAR_H) / 2;
              return (
                <g key={dev.uniqueName || dev.name}>
                  {idx > 0 && (
                    <line x1={PAD} y1={y} x2={width - PAD} y2={y} stroke={C.rowSep} strokeWidth={1} />
                  )}
                  <text
                    x={PAD}
                    y={y + ROW_H / 2}
                    dominantBaseline="middle"
                    fontSize={14}
                    fontWeight={500}
                    fill={C.textPrimary}
                  >
                    {truncateToWidth(dev.name, labelTextW)}
                  </text>
                  {dev.cells.map((cell) => {
                    const col = timeline.sprints.find((c) => c.index === cell.sprint);
                    if (!col) return null;
                    const x0 = fracToX(col.left);
                    const x1 = fracToX(col.right);
                    const cap = cell.capacity;
                    const u = cap > 0 ? cell.planned / cap : cell.planned > 0 ? 2 : 0;
                    if (u <= 0) return null; // blank, even mid-span
                    const over = u > 1;
                    const pct = cap > 0 ? Math.round((cell.planned / cap) * 100) : null;
                    const wide = x1 - x0 > 34;
                    return (
                      <g key={cell.sprint}>
                        <title>
                          {`${dev.name} — S${cell.sprint}\nPlanned: ${cell.planned} h\nCapacity: ${cell.capacity} h (${cell.source})\nUtilization: ${pct != null ? pct + '%' : 'no capacity'}`}
                        </title>
                        <rect
                          x={x0 + 1}
                          y={cellY}
                          width={Math.max(1, x1 - x0 - 2)}
                          height={BAR_H}
                          rx={3}
                          fill={over ? C.milestone : utilColor(u)}
                          stroke={over ? '#c0392b' : 'none'}
                          strokeWidth={over ? 1.5 : 0}
                        />
                        {wide && pct != null && (
                          <text
                            x={(x0 + x1) / 2}
                            y={y + ROW_H / 2}
                            dominantBaseline="middle"
                            textAnchor="middle"
                            fontSize={11}
                            fontWeight={600}
                            fill={u >= 0.5 ? '#ffffff' : C.textPrimary}
                          >
                            {pct}%
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          {devMode && developers.length === 0 && (
            <text
              x={trackLeft + 12}
              y={HEADER_H + ROW_H / 2}
              dominantBaseline="middle"
              fontSize={13}
              fill={C.textSecondary}
            >
              No developer data yet — run a sync (needs ADO task assignments + capacity).
            </text>
          )}

          {/* Today line across all rows */}
          {todayInRange && (
            <g>
              <line
                x1={todayX}
                y1={HEADER_H - 18}
                x2={todayX}
                y2={height - FOOTER_H + 4}
                stroke={C.today}
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
              <text
                x={todayNearRight ? todayX - 6 : todayX + 6}
                y={16}
                textAnchor={todayNearRight ? 'end' : 'start'}
                fontSize={11}
                fontWeight={600}
                fill={C.today}
              >
                {`Today · ${formatDisplay(today)}`}
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* Frozen label column: pinned on the left while the timeline scrolls.
          Mirrors the names drawn in the SVG (which the export still uses). */}
      {!present && (
        <div className="gantt-frozen" style={{ width: trackLeft, height }}>
          {labelNames.map((name, idx) => (
            <div
              key={`${idx}-${name}`}
              className="gantt-frozen-name"
              style={{ top: HEADER_H + idx * ROW_H, height: ROW_H, lineHeight: `${ROW_H}px`, left: PAD, width: labelTextW }}
              title={name}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

/** Utilization 0..1 -> light-to-dark blue (#e3eef9 -> #185FA5). */
function utilColor(u: number): string {
  const t = Math.max(0, Math.min(1, u));
  const a = [227, 238, 249];
  const b = [24, 95, 165];
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}
