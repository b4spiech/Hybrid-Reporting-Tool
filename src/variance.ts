import type { GanttRow } from './types';
import type { Timeline } from './sprints';

export type Variance = {
  status: 'ahead' | 'behind' | 'onTrack' | 'notApplicable';
  /** Whole-sprint gap: shaded edge minus today (+ = ahead of schedule). */
  deltaSprints: number;
  /** Normalized 0..1 position of the shaded (work-done) edge. */
  shadedFrac: number;
  /** Normalized 0..1 position of the today line. */
  todayFrac: number;
  /** Short, understated label, e.g. "+1 sprint", "−2 sprints", "on track". */
  label: string;
};

/**
 * Bar length encodes schedule; shading encodes work done. Variance is the gap
 * between where work has reached on the timeline (the shaded edge) and where
 * "today" sits — expressed in whole sprints.
 *
 * Both positions are normalized fractions in [0,1]; multiplying by the sprint
 * count converts a fraction into sprint-column units, so the gap is inherently
 * bounded by [-sprintCount, +sprintCount] and can never produce a runaway
 * value (the old "-20 sprints" bug came from a raw date diff divided by 7).
 */
export function computeVariance(
  row: GanttRow,
  timeline: Timeline,
  today: Date,
): Variance {
  const n = timeline.sprints.length;
  const start = Math.min(row.startSprint, row.endSprint);
  const end = Math.max(row.startSprint, row.endSprint);
  const left = timeline.columnLeft(start);
  const right = timeline.columnRight(end);

  const pct = clampPct(row.percentComplete) / 100;
  const shadedFrac = left + (right - left) * pct;
  const todayFrac = timeline.dateToFrac(today);

  // Variance only means something while a row is in flight. If today is outside
  // the row's scheduled span, there is no "behind/ahead" to report.
  const inFlight = todayFrac >= left && todayFrac <= right;
  if (!inFlight) {
    return { status: 'notApplicable', deltaSprints: 0, shadedFrac, todayFrac, label: '' };
  }

  // Gap in sprint-column units, rounded to whole sprints.
  const deltaSprints = Math.round((shadedFrac - todayFrac) * n);

  let status: Variance['status'] = 'onTrack';
  if (deltaSprints >= 1) status = 'ahead';
  else if (deltaSprints <= -1) status = 'behind';

  return { status, deltaSprints, shadedFrac, todayFrac, label: formatLabel(status, deltaSprints) };
}

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatLabel(status: Variance['status'], deltaSprints: number): string {
  if (status === 'onTrack') return 'on track';
  const mag = Math.abs(deltaSprints);
  const unit = mag === 1 ? 'sprint' : 'sprints';
  const sign = deltaSprints > 0 ? '+' : '−';
  return `${sign}${mag} ${unit}`;
}
