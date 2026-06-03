import type { SprintConfig } from './types';
import { addDays, diffDays, lastFridayOnOrBefore, parseISO } from './dates';

export type ComputedSprint = {
  index: number; // sprint number (1-based for the manual axis; the "Sprint N" number for ADO)
  durationDays: number; // real calendar length of this sprint
  start: Date; // day 1 of the sprint
  calendarEnd: Date; // last calendar day
  finish: Date; // milestone finish date (per endConvention, or the real ADO end)
  /** Exclusive boundary used for the continuous timeline (calendarEnd + 1 day). */
  boundaryEnd: Date;
  name?: string; // ADO IterationName, when sourced from ADO
};

/** Duration of every sprint in whole weeks (uniform fallback), minimum 1. */
export function sprintWeeks(config: SprintConfig): number {
  return Math.max(1, Math.round(config.defaultDurationWeeks));
}

/** True when the project has real ADO sprint dates to drive the axis. */
export function hasAdoDates(config: SprintConfig): boolean {
  return Array.isArray(config.sprintDates) && config.sprintDates.length > 0;
}

/**
 * Expand the SprintConfig into a list of dated sprints. When ADO sprint dates
 * are present they drive the axis (real, possibly non-uniform per-sprint dates);
 * otherwise fall back to the manual start date + uniform weeks.
 */
export function computeSprints(config: SprintConfig): ComputedSprint[] {
  if (hasAdoDates(config)) return computeFromAdoDates(config);
  return computeUniform(config);
}

function computeFromAdoDates(config: SprintConfig): ComputedSprint[] {
  const sorted = [...config.sprintDates!]
    .map((s) => ({ ...s, startD: parseISO(s.start), endD: parseISO(s.end) }))
    .filter((s) => !Number.isNaN(s.startD.getTime()) && !Number.isNaN(s.endD.getTime()))
    .sort((a, b) => a.startD.getTime() - b.startD.getTime());

  return sorted.map((s) => {
    const start = s.startD;
    const calendarEnd = s.endD >= start ? s.endD : start;
    const durationDays = Math.max(1, diffDays(calendarEnd, start) + 1);
    return {
      index: Number.isFinite(s.number) ? s.number : 0,
      durationDays,
      start,
      calendarEnd,
      finish: calendarEnd, // real ADO end date
      boundaryEnd: addDays(calendarEnd, 1),
      name: s.name,
    };
  });
}

function computeUniform(config: SprintConfig): ComputedSprint[] {
  const out: ComputedSprint[] = [];
  let cursor = parseISO(config.startDate);
  const count = Math.max(1, Math.round(config.sprintCount));
  const durationDays = sprintWeeks(config) * 7;

  for (let i = 1; i <= count; i++) {
    const start = cursor;
    const calendarEnd = addDays(start, durationDays - 1);
    const boundaryEnd = addDays(start, durationDays);
    const finish =
      config.endConvention === 'lastWorkingDay' ? lastFridayOnOrBefore(calendarEnd) : calendarEnd;
    out.push({ index: i, durationDays, start, calendarEnd, finish, boundaryEnd });
    cursor = boundaryEnd;
  }
  return out;
}

export function timelineStart(sprints: ComputedSprint[]): Date {
  return sprints[0].start;
}

export function timelineEnd(sprints: ComputedSprint[]): Date {
  return sprints[sprints.length - 1].boundaryEnd;
}

export type Column = ComputedSprint & { left: number; right: number };

/**
 * The timeline x-axis. Columns are laid left→right in chronological order, each
 * occupying a fraction of the track proportional to its real calendar length —
 * so non-uniform sprints render as different widths. Dates map onto each
 * column's real span, so the "today" line and variance respect actual dates.
 * Columns are keyed by sprint number for row lookups (row sprints are numbers).
 */
export type Timeline = {
  sprints: Column[];
  columnLeft(index: number): number;
  columnRight(index: number): number;
  dateToFrac(date: Date): number;
  fracToDate(frac: number): Date;
};

export function makeTimeline(sprints: ComputedSprint[]): Timeline {
  const total = sprints.reduce((a, s) => a + s.durationDays, 0) || 1;
  let acc = 0;
  const cols: Column[] = sprints.map((s) => {
    const left = acc / total;
    acc += s.durationDays;
    return { ...s, left, right: acc / total };
  });
  const byIndex = new Map<number, Column>(cols.map((c) => [c.index, c]));
  const first = cols[0];
  const last = cols[cols.length - 1];

  const columnLeft = (index: number): number => {
    const c = byIndex.get(index);
    if (c) return c.left;
    return index <= first.index ? first.left : last.right;
  };
  const columnRight = (index: number): number => {
    const c = byIndex.get(index);
    if (c) return c.right;
    return index <= first.index ? first.left : last.right;
  };

  const dateToFrac = (date: Date): number => {
    if (date <= first.start) return 0;
    if (date >= last.calendarEnd) return 1;
    for (const c of cols) {
      if (date < c.start) return c.left; // in a gap before this column
      if (date <= c.calendarEnd) {
        const within = diffDays(date, c.start) / c.durationDays;
        return c.left + within * (c.right - c.left);
      }
    }
    return 1;
  };

  const fracToDate = (frac: number): Date => {
    const clamped = Math.max(0, Math.min(1, frac));
    const col = cols.find((c) => clamped <= c.right) ?? last;
    const span = col.right - col.left || 1;
    const within = (clamped - col.left) / span;
    return addDays(col.start, Math.round(within * col.durationDays));
  };

  return { sprints: cols, columnLeft, columnRight, dateToFrac, fracToDate };
}
