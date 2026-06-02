import { forwardRef, useMemo } from 'react';
import type { GanttRow } from '../types';
import { computeSprints, makeTimeline } from '../sprints';
import type { SprintConfig } from '../types';
import { computeVariance, clampPct } from '../variance';
import { formatDisplay, formatShort } from '../dates';

type Props = {
  sprintsConfig: SprintConfig;
  rows: GanttRow[];
  today: Date;
};

// Geometry (intrinsic SVG pixels; the SVG scales via CSS).
const PAD = 24;
const LABEL_W = 180;
const COL_W = 104;
const HEADER_H = 76;
const ROW_H = 46;
const BAR_H = 24;
const FOOTER_H = 22;

// Blue + white palette. The chart renders on a white "paper" surface so PNG/SVG
// exports look identical regardless of OS theme; the surrounding app chrome is
// dark-mode aware via CSS.
const C = {
  boundary: '#e3eaf3',
  track: '#ffffff', // remaining / track bar: white fill
  trackStroke: '#cbd9ec', // thin light-blue border
  shade: '#2f6fb0', // completed (work done): medium blue
  milestone: '#0c447c', // dark blue
  behindTint: '#dce9f6', // variance cue: lighter blue (stays in family)
  today: '#33475b', // dark slate, dashed
  badge: '#1c5a99',
  textPrimary: '#1e2a3a',
  textSecondary: '#5a6b80',
  pctOnShade: '#ffffff',
  pctOnTrack: '#1e2a3a',
  rowSep: '#eef2f8',
};

export const Gantt = forwardRef<SVGSVGElement, Props>(function Gantt(
  { sprintsConfig, rows, today },
  ref,
) {
  const { sprints, timeline } = useMemo(() => {
    const sprints = computeSprints(sprintsConfig);
    return { sprints, timeline: makeTimeline(sprints) };
  }, [sprintsConfig]);

  const n = sprints.length;
  const trackLeft = PAD + LABEL_W;
  const trackW = n * COL_W;
  const width = trackLeft + trackW + PAD;
  const height = HEADER_H + Math.max(1, rows.length) * ROW_H + FOOTER_H;

  const fracToX = (frac: number) => trackLeft + frac * trackW;
  const todayX = fracToX(timeline.dateToFrac(today));
  const todayInRange = today >= sprints[0].start && today <= sprints[n - 1].boundaryEnd;
  const todayNearRight = todayX > width - 120;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Tracking Gantt chart"
      style={{ maxWidth: '100%', height: 'auto', display: 'block', fontFamily: 'inherit' }}
    >
      <rect x={0} y={0} width={width} height={height} fill="#ffffff" />

      {/* Sprint columns: gridlines + header labels */}
      {sprints.map((s) => {
        const x0 = trackLeft + (s.index - 1) * COL_W;
        const cx = x0 + COL_W / 2;
        return (
          <g key={s.index}>
            <line
              x1={x0}
              y1={HEADER_H - 18}
              x2={x0}
              y2={height - FOOTER_H}
              stroke={C.boundary}
              strokeWidth={1}
            />
            <text x={cx} y={36} textAnchor="middle" fontSize={14} fontWeight={600} fill={C.textPrimary}>
              {`S${s.index}`}
            </text>
            <text x={cx} y={54} textAnchor="middle" fontSize={11} fill={C.textSecondary}>
              {formatShort(s.finish)}
            </text>
          </g>
        );
      })}
      {/* Closing right boundary line */}
      <line
        x1={trackLeft + trackW}
        y1={HEADER_H - 18}
        x2={trackLeft + trackW}
        y2={height - FOOTER_H}
        stroke={C.boundary}
        strokeWidth={1}
      />

      {/* Rows */}
      {rows.map((row, idx) => {
        const y = HEADER_H + idx * ROW_H;
        const barY = y + (ROW_H - BAR_H) / 2;
        const start = Math.min(row.startSprint, row.endSprint);
        const end = Math.max(row.startSprint, row.endSprint);
        const barLeft = fracToX(timeline.columnLeft(start));
        const barRight = fracToX(timeline.columnRight(end));
        const barW = Math.max(2, barRight - barLeft);
        const v = computeVariance(row, timeline, today);
        const pct = clampPct(row.percentComplete);
        const shadedX = fracToX(v.shadedFrac);
        const shadedW = Math.max(0, shadedX - barLeft);
        const clipId = `clip-${row.id}`;
        const r = BAR_H / 2;
        // Variance tint stays in the blue family: a light-blue wash on the
        // remaining segment only when the row is behind schedule.
        const tint = v.status === 'behind' ? C.behindTint : 'transparent';
        const diamondR = BAR_H * 0.42;
        // Place the "NN%" label inside the shaded fill when there's room,
        // otherwise just past the shaded edge over the white track.
        const pctLabel = `${pct}%`;
        const pctInside = shadedW > 30;
        const varianceText = v.status === 'ahead' || v.status === 'behind' ? v.label : '';

        return (
          <g key={row.id}>
            <title>
              {`${row.name}\nCompletion: S${end} · ${formatDisplay(sprints[end - 1]?.finish ?? sprints[n - 1].finish)}\nProgress: ${pct}%${varianceText ? `  (${varianceText})` : ''}${row.notes ? `\n${row.notes}` : ''}`}
            </title>

            {idx > 0 && (
              <line x1={PAD} y1={y} x2={width - PAD} y2={y} stroke={C.rowSep} strokeWidth={1} />
            )}

            {/* Row name */}
            <text
              x={PAD}
              y={y + ROW_H / 2}
              dominantBaseline="middle"
              fontSize={14}
              fontWeight={500}
              fill={C.textPrimary}
            >
              {row.name}
            </text>

            {/* Track + fills, clipped to a rounded-rect bar shape */}
            <clipPath id={clipId}>
              <rect x={barLeft} y={barY} width={barW} height={BAR_H} rx={r} ry={r} />
            </clipPath>
            <g clipPath={`url(#${clipId})`}>
              <rect x={barLeft} y={barY} width={barW} height={BAR_H} fill={C.track} />
              {/* Remaining-segment variance tint */}
              <rect x={shadedX} y={barY} width={Math.max(0, barRight - shadedX)} height={BAR_H} fill={tint} />
              {/* Work done */}
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

            {/* Percent-complete label (always a clean 0–100% value) */}
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

            {/* Milestone diamond at completion */}
            <path
              d={diamond(barRight, barY + BAR_H / 2, diamondR)}
              fill={C.milestone}
              stroke="#ffffff"
              strokeWidth={1.5}
            />

            {/* Understated variance badge (whole sprints; blank when on track) */}
            {varianceText && (
              <text
                x={barRight + diamondR + 8}
                y={y + ROW_H / 2}
                dominantBaseline="middle"
                fontSize={11}
                fontWeight={600}
                fill={C.badge}
              >
                {varianceText}
              </text>
            )}
          </g>
        );
      })}

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
  );
});

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}
