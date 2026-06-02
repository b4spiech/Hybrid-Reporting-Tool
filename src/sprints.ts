import type { SprintConfig } from './types';
import {
  addDays,
  diffDays,
  lastFridayOnOrBefore,
  parseISO,
} from './dates';

export type ComputedSprint = {
  index: number; // 1-based
  durationWeeks: number;
  durationDays: number; // durationWeeks * 7
  start: Date; // day 1 of the sprint
  calendarEnd: Date; // last calendar day (start + duration - 1)
  finish: Date; // milestone finish date per endConvention
  /** Exclusive boundary used for the continuous timeline (start of next sprint). */
  boundaryEnd: Date;
};

/** Duration of every sprint in whole weeks (uniform), minimum 1. */
export function sprintWeeks(config: SprintConfig): number {
  return Math.max(1, Math.round(config.defaultDurationWeeks));
}

/**
 * Expand the SprintConfig into a contiguous list of dated sprints. Each sprint
 * spans `weeks * 7` calendar days; sprint i+1 starts the day after sprint i's
 * last calendar day.
 */
export function computeSprints(config: SprintConfig): ComputedSprint[] {
  const out: ComputedSprint[] = [];
  let cursor = parseISO(config.startDate);
  const count = Math.max(1, Math.round(config.sprintCount));

  for (let i = 1; i <= count; i++) {
    const durationWeeks = sprintWeeks(config);
    const durationDays = durationWeeks * 7;
    const start = cursor;
    const calendarEnd = addDays(start, durationDays - 1);
    const boundaryEnd = addDays(start, durationDays); // == next sprint start
    const finish =
      config.endConvention === 'lastWorkingDay'
        ? lastFridayOnOrBefore(calendarEnd)
        : calendarEnd;
    out.push({ index: i, durationWeeks, durationDays, start, calendarEnd, finish, boundaryEnd });
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

/**
 * The timeline x-axis. Each sprint occupies an equal-width column [0..1] of the
 * track area, but *within* a column dates map linearly onto that sprint's real
 * calendar span. This lets columns stay visually uniform (S1..SN) while the
 * "today" line and variance still respect actual durations.
 */
export type Timeline = {
  sprints: ComputedSprint[];
  /** Left edge (0..1) of a 1-based sprint column. */
  columnLeft(index: number): number;
  /** Right edge (0..1) of a 1-based sprint column. */
  columnRight(index: number): number;
  /** Map a date to a normalized 0..1 position, clamped to the timeline. */
  dateToFrac(date: Date): number;
  /** Inverse of dateToFrac: a normalized position back to a Date. */
  fracToDate(frac: number): Date;
};

export function makeTimeline(sprints: ComputedSprint[]): Timeline {
  const n = sprints.length;
  const colWidth = 1 / n;

  const columnLeft = (index: number) => (index - 1) * colWidth;
  const columnRight = (index: number) => index * colWidth;

  const dateToFrac = (date: Date): number => {
    if (date <= sprints[0].start) return 0;
    if (date >= sprints[n - 1].boundaryEnd) return 1;
    for (const s of sprints) {
      if (date >= s.start && date < s.boundaryEnd) {
        const within = diffDays(date, s.start) / s.durationDays;
        return columnLeft(s.index) + within * colWidth;
      }
    }
    return 1;
  };

  const fracToDate = (frac: number): Date => {
    const clamped = Math.max(0, Math.min(1, frac));
    const pos = clamped / colWidth; // column-space, 0..n
    let idx = Math.floor(pos) + 1;
    if (idx > n) idx = n;
    const within = pos - (idx - 1); // 0..1 inside the column
    const s = sprints[idx - 1];
    return addDays(s.start, within * s.durationDays);
  };

  return { sprints, columnLeft, columnRight, dateToFrac, fracToDate };
}
