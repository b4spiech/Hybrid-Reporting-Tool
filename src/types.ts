export type SprintConfig = {
  startDate: string; // ISO date of day 1 of Sprint 1
  sprintCount: number; // e.g. 10
  defaultDurationDays: number; // e.g. 7
  endConvention: 'lastWorkingDay' | 'calendarEnd'; // milestone finish date rule
  durationOverrides?: Record<number, number>; // 1-based sprintIndex -> custom days
};

export type GanttRow = {
  id: string;
  name: string; // e.g. "ERP"
  startSprint: number; // 1-based; defaults to 1
  endSprint: number; // completion milestone sprint
  percentComplete: number; // 0..100, drives the shaded portion
  notes?: string; // optional free text (stretch: tooltip)
};

export type ProjectState = {
  title: string;
  sprints: SprintConfig;
  rows: GanttRow[];
  todayOverride?: string; // ISO; if unset, use the real current date
};
