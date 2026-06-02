import type { GanttRow } from './types';
import { makeId } from './storage';
import { clampPct } from './variance';

type Field = 'name' | 'start' | 'end' | 'pct' | 'notes';

export type ParsedWorkstream = {
  name: string;
  startSprint?: number; // undefined when the cell is blank/unparseable
  endSprint?: number;
  percentComplete?: number; // already clamped to 0..100, undefined when blank
  notes?: string;
};

export type SheetParse = {
  rows: ParsedWorkstream[];
  hasNotesColumn: boolean;
  blankSkipped: number; // rows that carried data but no name
};

export type ExcelMergeResult = {
  rows: GanttRow[];
  updated: number;
  added: number;
  skipped: number;
};

/** Map a header cell to a canonical field, tolerant of case and spacing. */
function headerField(raw: string): Field | null {
  const k = raw.toLowerCase().replace(/[^a-z%]/g, '');
  if (k === 'name') return 'name';
  if (k === 'startsprint' || k === 'start') return 'start';
  if (k === 'completionsprint' || k === 'endsprint' || k === 'completion' || k === 'end') return 'end';
  if (k === '%complete' || k === 'percentcomplete' || k === 'complete' || k === 'percent' || k === '%')
    return 'pct';
  if (k === 'notes' || k === 'note') return 'notes';
  return null;
}

function toInt(cell: unknown): number | undefined {
  if (cell === '' || cell === null || cell === undefined) return undefined;
  const n = Number(cell);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/** Read the first worksheet of an .xlsx file into parsed workstream rows. */
export async function readWorkstreamsXlsx(file: File): Promise<SheetParse> {
  // Lazy-load SheetJS so it only ships when the user actually imports Excel.
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const empty: SheetParse = { rows: [], hasNotesColumn: false, blankSkipped: 0 };
  if (!sheet) return empty;

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
  });
  return parseSheetRows(aoa);
}

/**
 * Pure parser over an array-of-arrays (header row + data rows). Locates the
 * header row by finding the first row that contains a "Name" column, so a
 * title row above the headers is tolerated.
 */
export function parseSheetRows(aoa: unknown[][]): SheetParse {
  const empty: SheetParse = { rows: [], hasNotesColumn: false, blankSkipped: 0 };

  let headerIdx = -1;
  const col: Partial<Record<Field, number>> = {};
  for (let i = 0; i < aoa.length; i++) {
    const map: Partial<Record<Field, number>> = {};
    aoa[i].forEach((cell, idx) => {
      const f = headerField(String(cell ?? ''));
      if (f && map[f] === undefined) map[f] = idx;
    });
    if (map.name !== undefined) {
      headerIdx = i;
      Object.assign(col, map);
      break;
    }
  }
  if (headerIdx === -1 || col.name === undefined) return empty;

  const rows: ParsedWorkstream[] = [];
  let blankSkipped = 0;
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    const name = String(row[col.name] ?? '').trim();
    if (!name) {
      // A row with no name but some content — can't match or create it.
      if (row.some((c) => String(c ?? '').trim() !== '')) blankSkipped++;
      continue;
    }
    const pctRaw = col.pct !== undefined ? row[col.pct] : '';
    const percentComplete =
      pctRaw === '' || pctRaw === null || pctRaw === undefined
        ? undefined
        : clampPct(Number(String(pctRaw).replace('%', '').trim()));
    const notesRaw = col.notes !== undefined ? String(row[col.notes] ?? '').trim() : '';
    rows.push({
      name,
      startSprint: col.start !== undefined ? toInt(row[col.start]) : undefined,
      endSprint: col.end !== undefined ? toInt(row[col.end]) : undefined,
      percentComplete,
      notes: notesRaw || undefined,
    });
  }
  return { rows, hasNotesColumn: col.notes !== undefined, blankSkipped };
}

/**
 * Merge parsed rows into the active project's workstreams. Match by name
 * (case-insensitive): update when found, append when not. Rows whose provided
 * sprint numbers fall outside 1..sprintCount are flagged (skipped) rather than
 * applied. Returns the new rows plus a summary count.
 */
export function mergeWorkstreams(
  existing: GanttRow[],
  parse: SheetParse,
  sprintCount: number,
): ExcelMergeResult {
  const rows: GanttRow[] = existing.map((r) => ({ ...r }));
  const indexByName = new Map<string, number>();
  rows.forEach((r, i) => indexByName.set(r.name.trim().toLowerCase(), i));

  let updated = 0;
  let added = 0;
  let skipped = parse.blankSkipped;

  const inRange = (v: number | undefined) => v === undefined || (v >= 1 && v <= sprintCount);

  for (const p of parse.rows) {
    if (!inRange(p.startSprint) || !inRange(p.endSprint)) {
      skipped++;
      continue;
    }
    const key = p.name.trim().toLowerCase();
    const idx = indexByName.get(key);
    if (idx !== undefined) {
      const cur = rows[idx];
      rows[idx] = {
        ...cur,
        startSprint: p.startSprint ?? cur.startSprint,
        endSprint: p.endSprint ?? cur.endSprint,
        percentComplete: p.percentComplete ?? cur.percentComplete,
        notes: parse.hasNotesColumn ? p.notes : cur.notes,
      };
      updated++;
    } else {
      const start = p.startSprint ?? 1;
      const end = p.endSprint ?? start;
      rows.push({
        id: makeId(),
        name: p.name,
        startSprint: start,
        endSprint: end,
        percentComplete: p.percentComplete ?? 0,
        notes: parse.hasNotesColumn ? p.notes : undefined,
      });
      indexByName.set(key, rows.length - 1);
      added++;
    }
  }

  return { rows, updated, added, skipped };
}
