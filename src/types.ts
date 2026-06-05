/** A real sprint's dates, sourced from Azure DevOps iterations. */
export type SprintDate = {
  number: number; // sprint number parsed from "Sprint N"
  name: string; // ADO IterationName
  start: string; // ISO date
  end: string; // ISO date (real end; drives the milestone date)
};

export type SprintConfig = {
  // Manual fallback axis (used only when sprintDates is absent/empty):
  startDate: string; // ISO date of day 1 of Sprint 1
  sprintCount: number; // e.g. 10
  defaultDurationWeeks: number; // every sprint spans defaultDurationWeeks * 7 days
  endConvention: 'lastWorkingDay' | 'calendarEnd'; // milestone finish date rule
  // Real per-sprint dates from ADO. When present, these drive the axis (labels,
  // column widths, today line, milestone dates) and the manual fields above are
  // ignored. Refreshed on every sync.
  sprintDates?: SprintDate[];
};

export type GanttRow = {
  id: string;
  name: string; // e.g. "ERP"
  startSprint: number; // 1-based; defaults to 1
  endSprint: number; // completion milestone sprint
  percentComplete: number; // 0..100, drives the shaded portion
  notes?: string; // optional free text (stretch: tooltip)
  adoId?: number; // Azure DevOps work-item id, when ingested from ADO
  sprintUnset?: boolean; // ingest provided no valid endSprint; flagged, not crashed
};

/** Manual, persisted inputs for the schedule-risk page (per project). */
export type ProjectRisk = {
  milestoneName?: string; // default "Go-live"
  bestRateOverride?: number; // hrs/wk (fastest); else computed from ADO history
  worstRateOverride?: number; // hrs/wk (slowest); else computed from ADO history
  postWeeks?: number; // post-sprint duration in weeks
  sliderOverride?: number; // 0..1 what-if position in the corridor
  projectFrom?: string; // ISO override for the projection anchor (default today)
  remainingOverride?: number; // override for remaining work hrs (else ADO totalRemainingHrs)
  historicalStart?: string; // ISO override for the observed-rate start
};

export type Project = {
  id: string;
  name: string;
  sprints: SprintConfig;
  rows: GanttRow[];
  todayOverride?: string; // ISO; if unset, use the real current date
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  // Free-text description and alias terms used to tag-match transcripts.
  description?: string;
  aliases?: string[];
  // Azure DevOps binding (the sync mapping key — distinct from the app's own id).
  adoOrg?: string;
  adoProjectName?: string;
  adoProjectGuid?: string; // stable key; matched on first when present
  // Project-level task-hour totals, summed across all features' tasks on sync.
  totalCompletedHrs?: number;
  totalRemainingHrs?: number;
  // Schedule-risk manual inputs.
  risk?: ProjectRisk;
};

export type AppState = {
  projects: Project[];
  activeProjectId: string | null;
};
