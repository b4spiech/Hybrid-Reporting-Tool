import { addDays, diffDays } from './dates';
import type { ComputedSprint } from './sprints';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export type ObservedRate = {
  perWeek: number; // hrs/wk (what every rate in the app is expressed in)
  perSprint: number; // completed hrs ÷ sprints elapsed
  sprintsElapsed: number; // e.g. 30 when today falls in Sprint 30 (counted from Sprint 1)
  avgSprintDays: number; // average start-to-start spacing of the counted sprints
};

/**
 * Observed delivery rate = completed hours ÷ sprints elapsed, where the current
 * (in-progress) sprint counts — e.g. 1104 hrs in Sprint 30 → 36.8 hrs/sprint.
 * Converted to hrs/wk using the counted sprints' real average length (identical
 * for 1-week sprints). `historicalStart` (optional) starts the count at the
 * sprint containing that date instead of Sprint 1. Undefined before Sprint 1.
 */
export function observedRate(
  totalCompletedHrs: number,
  sprints: ComputedSprint[],
  today: Date,
  historicalStart?: Date,
): ObservedRate | undefined {
  const started = sprints.filter((s) => s.start.getTime() <= today.getTime());
  const current = started[started.length - 1];
  if (!current) return undefined;
  const from = historicalStart
    ? sprints.find((s) => historicalStart.getTime() < s.boundaryEnd.getTime()) ?? sprints[0]
    : sprints[0];
  // Sprint numbers come from ADO ("Sprint N"); count by number so a gap in the
  // dated iterations doesn't undercount. Fall back to position if numbers are odd.
  const byNumber = current.index - (historicalStart ? from.index : 1) + 1;
  const counted = started.filter((s) => s.start.getTime() >= from.start.getTime());
  const sprintsElapsed = byNumber >= 1 ? byNumber : counted.length;
  if (sprintsElapsed < 1) return undefined;
  // Sprint cadence = start-to-start spacing (ADO iterations usually end on a
  // Friday, so their own length would undercount the weekend). With one sprint,
  // round its length up to whole weeks.
  const first = counted[0];
  const lastCounted = counted[counted.length - 1];
  const avgSprintDays =
    counted.length >= 2
      ? diffDays(lastCounted.start, first.start) / (counted.length - 1)
      : first
        ? Math.ceil(first.durationDays / 7) * 7
        : 7;
  const perSprint = totalCompletedHrs / sprintsElapsed;
  return { perWeek: (perSprint * 7) / avgSprintDays, perSprint, sprintsElapsed, avgSprintDays };
}

/** "37 hrs/wk (1104 hrs ÷ 30 sprints)" — shows the derivation; adds hrs/sprint for non-weekly sprints. */
export function describeObservedRate(o: ObservedRate | undefined, totalCompletedHrs: number): string {
  if (!o) return '— (before Sprint 1)';
  const perSprint = Math.abs(o.avgSprintDays - 7) >= 1 ? ` = ${Math.round(o.perSprint)} hrs/sprint` : '';
  return `${Math.round(o.perWeek)} hrs/wk (${Math.round(totalCompletedHrs)} hrs ÷ ${o.sprintsElapsed} sprint${o.sprintsElapsed === 1 ? '' : 's'}${perSprint})`;
}

/**
 * Where the observed rate falls in the best→worst corridor (0..1). Computed in
 * duration space (1/rate), so faster-than-best pins to 0 and slower-than-worst to 1.
 * Defaults to 0.5 when the observed rate isn't computable.
 */
export function sliderDefault(obs: number | undefined, bestRate: number, worstRate: number): number {
  if (obs && obs > 0 && bestRate > 0 && worstRate > 0) {
    const denom = 1 / worstRate - 1 / bestRate;
    if (denom !== 0) return clamp01((1 / obs - 1 / bestRate) / denom);
  }
  return 0.5;
}

/**
 * The burndown rate implied by the selected completion date (hrs/wk):
 * remainingHrs ÷ weeks(projectFrom → selCompDate). Derived from the completion,
 * not a linear blend of best/worst. Pinned to exactly bestRate/worstRate at the
 * slider extremes; null when not computable.
 */
export function impliedRate(args: {
  remainingHrs: number;
  projectFrom: Date;
  selCompDate: Date | null;
  s: number;
  bestRate: number;
  worstRate: number;
}): number | null {
  const { remainingHrs, projectFrom, selCompDate, s, bestRate, worstRate } = args;
  if (s <= 0) return bestRate;
  if (s >= 1) return worstRate;
  if (!selCompDate) return null;
  const weeks = diffDays(selCompDate, projectFrom) / 7;
  return weeks > 0 ? remainingHrs / weeks : null;
}

export type Milestones = {
  compBestDate: Date | null;
  compWorstDate: Date | null;
  bestMs: Date | null;
  worstMs: Date | null;
  selCompDate: Date | null;
  selMs: Date | null;
  windowWeeks: number | null;
};

/**
 * Project completion + milestone dates forward from `projectFrom`. Used for the
 * cards/labels only — never for the schematic's x positions.
 */
export function projectMilestones(args: {
  remainingHrs: number;
  bestRate: number;
  worstRate: number;
  postWeeks: number;
  projectFrom: Date;
  s: number;
}): Milestones {
  const { remainingHrs, bestRate, worstRate, postWeeks, projectFrom } = args;
  const s = clamp01(args.s);

  const projDate = (rate: number) =>
    rate > 0 ? addDays(projectFrom, Math.round((remainingHrs / rate) * 7)) : null;
  const addPost = (d: Date | null) => (d ? addDays(d, Math.round(postWeeks * 7)) : null);

  const compBestDate = projDate(bestRate);
  const compWorstDate = projDate(worstRate);
  const bestMs = addPost(compBestDate);
  const worstMs = addPost(compWorstDate);
  const selCompDate =
    compBestDate && compWorstDate
      ? addDays(compBestDate, Math.round(s * diffDays(compWorstDate, compBestDate)))
      : null;
  const selMs = addPost(selCompDate);
  const windowWeeks = bestMs && worstMs ? Math.round(diffDays(worstMs, bestMs) / 7) : null;

  return { compBestDate, compWorstDate, bestMs, worstMs, selCompDate, selMs, windowWeeks };
}
