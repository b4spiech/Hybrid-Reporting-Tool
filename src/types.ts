export type SprintConfig = {
  startDate: string; // ISO date of day 1 of Sprint 1
  sprintCount: number; // e.g. 10
  defaultDurationWeeks: number; // every sprint spans defaultDurationWeeks * 7 days
  endConvention: 'lastWorkingDay' | 'calendarEnd'; // milestone finish date rule
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

export type Project = {
  id: string;
  name: string;
  sprints: SprintConfig;
  rows: GanttRow[];
  todayOverride?: string; // ISO; if unset, use the real current date
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  // Azure DevOps binding (the sync mapping key — distinct from the app's own id).
  adoOrg?: string;
  adoProjectName?: string;
  adoProjectGuid?: string; // stable key; matched on first when present
};

export type AppState = {
  projects: Project[];
  activeProjectId: string | null;
};
