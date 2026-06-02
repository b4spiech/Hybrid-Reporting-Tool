import type { GanttRow } from './types';
import { diffDays } from './dates';
import type { Timeline } from './sprints';

export type Variance = {
  status: 'ahead' | 'behind' | 'onTrack';
  deltaDays: number; // shaded edge minus today, in days (+ = ahead of schedule)
  /** Normalized 0..1 position of the shaded (work-done) edge. */
  shadedFrac: number;
  /** Short, understated label, e.g. "+2d", "-1 sprint", "on track". */
  label: string;
};

/**
 * Bar length encodes schedule; shading encodes work done. Variance is the gap
 * between where work has reached on the timeline and where "today" sits.
 */
export function computeVariance(
  row: GanttRow,
  timeline: Timeline,
  today: Date,
): Variance {
  const start = Math.min(row.startSprint, row.endSprint);
  const end = Math.max(row.startSprint, row.endSprint);
  const left = timeline.columnLeft(start);
  const right = timeline.columnRight(end);
  const pct = Math.max(0, Math.min(100, row.percentComplete)) / 100;
  const shadedFrac = left + (right - left) * pct;

  const shadedDate = timeline.fracToDate(shadedFrac);
  const deltaDays = diffDays(shadedDate, today);

  // Average sprint length over the row's span, for "in sprints" phrasing.
  const spanSprints = end - start + 1;
  let spanDays = 0;
  for (const s of timeline.sprints) {
    if (s.index >= start && s.index <= end) spanDays += s.durationDays;
  }
  const avgSprintDays = spanDays / spanSprints || 7;

  let status: Variance['status'] = 'onTrack';
  if (deltaDays >= 1) status = 'ahead';
  else if (deltaDays <= -1) status = 'behind';

  return { status, deltaDays, shadedFrac, label: formatLabel(deltaDays, avgSprintDays) };
}

function formatLabel(deltaDays: number, avgSprintDays: number): string {
  if (deltaDays > -1 && deltaDays < 1) return 'on track';
  const sign = deltaDays > 0 ? '+' : '−';
  const mag = Math.abs(deltaDays);
  if (mag >= avgSprintDays) {
    const sprints = Math.round(mag / avgSprintDays);
    return `${sign}${sprints} sprint${sprints === 1 ? '' : 's'}`;
  }
  return `${sign}${mag}d`;
}
