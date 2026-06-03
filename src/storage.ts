import type { AppState, GanttRow, Project, SprintConfig } from './types';

export function makeId(): string {
  return 'r' + Math.random().toString(36).slice(2, 9);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function exampleRow(
  name: string,
  startSprint: number,
  endSprint: number,
  percentComplete: number,
): GanttRow {
  return { id: makeId(), name, startSprint, endSprint, percentComplete };
}

export function defaultSprintConfig(): SprintConfig {
  return {
    startDate: '2026-01-05', // a Monday
    sprintCount: 10,
    defaultDurationWeeks: 1,
    endConvention: 'lastWorkingDay',
  };
}

/** A fresh project with sensible defaults and one example workstream. */
export function makeProject(name: string): Project {
  const ts = nowISO();
  return {
    id: makeId(),
    name,
    sprints: defaultSprintConfig(),
    rows: [exampleRow('ERP', 1, 6, 45)],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function defaultAppState(): AppState {
  const project = makeProject('Project 1');
  return { projects: [project], activeProjectId: project.id };
}

/** Deep-copy a project under a brand-new id (for Duplicate / merge-import). */
export function cloneProjectWithNewId(project: Project, name = project.name): Project {
  const ts = nowISO();
  return {
    ...project,
    id: makeId(),
    name,
    rows: project.rows.map((r) => ({ ...r, id: makeId() })),
    createdAt: ts,
    updatedAt: ts,
  };
}

// --- Normalization -------------------------------------------------------

/**
 * Coerce arbitrary parsed JSON into a valid AppState. Recognizes three shapes:
 *  - a new AppState ({ projects, activeProjectId })
 *  - a legacy single-project record ({ title, sprints, rows, ... }) -> wrapped
 *    as the first project, named from its title (or "Project 1")
 *  - anything else -> a default AppState
 */
export function normalizeAppState(input: unknown): AppState {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.projects)) {
      const projects = obj.projects
        .map((p) => normalizeProject(p))
        .filter((p): p is Project => p !== null);
      if (projects.length === 0) return defaultAppState();
      const requested = typeof obj.activeProjectId === 'string' ? obj.activeProjectId : null;
      const activeProjectId = projects.some((p) => p.id === requested)
        ? requested
        : projects[0].id;
      return { projects, activeProjectId };
    }
    // Legacy single-project shape (has rows/sprints but no projects array).
    if ('rows' in obj || 'sprints' in obj || 'title' in obj) {
      const name = typeof obj.title === 'string' && obj.title.trim() ? obj.title : 'Project 1';
      const project = normalizeProject(obj, name) ?? makeProject(name);
      return { projects: [project], activeProjectId: project.id };
    }
  }
  return defaultAppState();
}

/** Validate/repair a single project (also used for project JSON import). */
export function normalizeProject(input: unknown, fallbackName = 'Untitled project'): Project | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const ts = nowISO();
  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name
      : typeof obj.title === 'string' && obj.title.trim()
        ? obj.title
        : fallbackName;

  const rows: GanttRow[] = Array.isArray(obj.rows)
    ? obj.rows.map(normalizeRow).filter((r): r is GanttRow => r !== null)
    : [];

  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : makeId(),
    name,
    sprints: normalizeSprints(obj.sprints),
    rows: rows.length ? rows : [exampleRow('ERP', 1, 6, 45)],
    todayOverride: typeof obj.todayOverride === 'string' ? obj.todayOverride : undefined,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : ts,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : ts,
  };
}

/**
 * Parse imported JSON into a list of projects, reporting whether the source was
 * a whole collection or a single project (drives the replace/merge prompt).
 */
export function projectsFromImport(input: unknown): { projects: Project[]; wasCollection: boolean } {
  if (input && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).projects)) {
    const state = normalizeAppState(input);
    return { projects: state.projects, wasCollection: true };
  }
  const project = normalizeProject(input, 'Imported project');
  return { projects: project ? [project] : [], wasCollection: false };
}

function normalizeSprints(input: unknown): SprintConfig {
  const base = defaultSprintConfig();
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const legacyDays = 'defaultDurationDays' in s && !('defaultDurationWeeks' in s);
  const defaultDurationWeeks = legacyDays
    ? clampInt(daysToWeeks(s.defaultDurationDays), base.defaultDurationWeeks, 1, 52)
    : clampInt(s.defaultDurationWeeks, base.defaultDurationWeeks, 1, 52);

  return {
    startDate: typeof s.startDate === 'string' ? s.startDate : base.startDate,
    sprintCount: clampInt(s.sprintCount, base.sprintCount, 1, 60),
    defaultDurationWeeks,
    endConvention: s.endConvention === 'calendarEnd' ? 'calendarEnd' : 'lastWorkingDay',
  };
}

function normalizeRow(input: unknown): GanttRow | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' ? r.id : makeId(),
    name: typeof r.name === 'string' ? r.name : 'Untitled',
    startSprint: clampInt(r.startSprint, 1, 1, 60),
    endSprint: clampInt(r.endSprint, 1, 1, 60),
    percentComplete: clampInt(r.percentComplete, 0, 0, 100),
    notes: typeof r.notes === 'string' ? r.notes : undefined,
    // Preserve ingest metadata so a later UI edit + re-save doesn't drop it.
    adoId: typeof r.adoId === 'number' && Number.isFinite(r.adoId) ? r.adoId : undefined,
    sprintUnset: r.sprintUnset === true ? true : undefined,
  };
}

function daysToWeeks(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, Math.round(days / 7));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
