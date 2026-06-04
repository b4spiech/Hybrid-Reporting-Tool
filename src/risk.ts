import { addDays, diffDays } from './dates';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Observed delivery rate (hrs/wk) from completed work over elapsed weeks. Guarded. */
export function observedRate(
  totalCompletedHrs: number,
  historicalStart: Date,
  today: Date,
): number | undefined {
  const weeks = Math.max(0, diffDays(today, historicalStart) / 7);
  return weeks > 0 ? totalCompletedHrs / weeks : undefined;
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
