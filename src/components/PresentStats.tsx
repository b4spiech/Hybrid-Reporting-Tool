import type { Project } from '../types';
import { computeSprints } from '../sprints';
import { parseISO } from '../dates';
import { observedRate as computeObservedRate } from '../risk';

type Props = {
  project: Project;
  today: Date;
};

/** Three key stats shown below the Gantt chart in presentation mode. */
export function PresentStats({ project, today }: Props) {
  const totalCompletedHrs = project.totalCompletedHrs ?? 0;
  const totalRemainingDefault = project.totalRemainingHrs ?? 0;
  const remainingHrs = project.risk?.remainingOverride ?? totalRemainingDefault;

  const sprints = computeSprints(project.sprints);
  const historicalStart = project.risk?.historicalStart
    ? parseISO(project.risk.historicalStart)
    : sprints[0].start;
  const observedRate = computeObservedRate(totalCompletedHrs, historicalStart, today);

  return (
    <div className="risk-present-stats">
      <div>
        <span>Observed rate</span>
        <strong>{observedRate != null ? Math.round(observedRate) : '—'} hrs/wk</strong>
      </div>
      <div>
        <span>Completed to date</span>
        <strong>{Math.round(totalCompletedHrs)} hrs</strong>
      </div>
      <div>
        <span>Work remaining</span>
        <strong>{Math.round(remainingHrs)} hrs</strong>
      </div>
    </div>
  );
}
