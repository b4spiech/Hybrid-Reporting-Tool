import type { GanttRow, ProjectState } from './types';

const STORAGE_KEY = 'tracking-gantt.project.v1';

export function makeId(): string {
  return 'r' + Math.random().toString(36).slice(2, 9);
}

export function defaultState(): ProjectState {
  return {
    title: 'Hybrid program — weekly status',
    sprints: {
      startDate: '2026-01-05', // a Monday
      sprintCount: 10,
      defaultDurationDays: 7,
      endConvention: 'lastWorkingDay',
      durationOverrides: {},
    },
    rows: [exampleRow('ERP', 1, 6, 45)],
  };
}

export function exampleRow(
  name: string,
  startSprint: number,
  endSprint: number,
  percentComplete: number,
): GanttRow {
  return { id: makeId(), name, startSprint, endSprint, percentComplete };
}

export function loadState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalize(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

export function saveState(state: ProjectState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or disabled storage — non-fatal; the in-memory state still works.
  }
}

/**
 * Coerce arbitrary parsed JSON (from storage or import) into a valid
 * ProjectState, falling back to defaults for anything missing or malformed.
 */
export function normalize(input: unknown): ProjectState {
  const base = defaultState();
  if (!input || typeof input !== 'object') return base;
  const obj = input as Record<string, unknown>;
  const s = (obj.sprints ?? {}) as Record<string, unknown>;

  const sprints: ProjectState['sprints'] = {
    startDate: typeof s.startDate === 'string' ? s.startDate : base.sprints.startDate,
    sprintCount: clampInt(s.sprintCount, base.sprints.sprintCount, 1, 60),
    defaultDurationDays: clampInt(s.defaultDurationDays, base.sprints.defaultDurationDays, 1, 365),
    endConvention:
      s.endConvention === 'calendarEnd' ? 'calendarEnd' : 'lastWorkingDay',
    durationOverrides: normalizeOverrides(s.durationOverrides),
  };

  const rows: GanttRow[] = Array.isArray(obj.rows)
    ? obj.rows.map(normalizeRow).filter((r): r is GanttRow => r !== null)
    : base.rows;

  return {
    title: typeof obj.title === 'string' ? obj.title : base.title,
    sprints,
    rows: rows.length ? rows : base.rows,
    todayOverride: typeof obj.todayOverride === 'string' ? obj.todayOverride : undefined,
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
  };
}

function normalizeOverrides(input: unknown): Record<number, number> {
  const out: Record<number, number> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const idx = Number(k);
      const days = Number(v);
      if (Number.isInteger(idx) && idx >= 1 && Number.isFinite(days) && days >= 1) {
        out[idx] = Math.round(days);
      }
    }
  }
  return out;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
