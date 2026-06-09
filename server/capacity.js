// Pure helpers for the Developers view: planned-hours aggregation and ADO team
// capacity math. No I/O, so unit-testable.

const WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Count days in [start, end] (inclusive) that fall on a working weekday and are
 * not inside any days-off range.
 */
export function workingDaysBetween(startISO, endISO, workingDays, daysOffRanges = []) {
  const start = parseDate(startISO);
  const end = parseDate(endISO);
  if (!start || !end || end < start) return 0;
  const wd = new Set((workingDays || []).map((d) => String(d).toLowerCase()));
  if (wd.size === 0) return 0;
  const off = (daysOffRanges || [])
    .map((r) => ({ s: parseDate(r.start), e: parseDate(r.end) }))
    .filter((r) => r.s && r.e);

  let count = 0;
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!wd.has(WEEKDAY[d.getUTCDay()])) continue;
    if (off.some((r) => d >= r.s && d <= r.e)) continue;
    count++;
  }
  return count;
}

/** capacityPerDay × net working days in the iteration (minus member + team days off). */
export function computeCapacityHours({
  startDate,
  finishDate,
  workingDays,
  capacityPerDay,
  memberDaysOff = [],
  teamDaysOff = [],
}) {
  const days = workingDaysBetween(startDate, finishDate, workingDays, [...memberDaysOff, ...teamDaysOff]);
  return Math.max(0, (Number(capacityPerDay) || 0) * days);
}

/**
 * Aggregate normalized task rows ({ name, uniqueName, sprint, planned }) into a
 * per-developer planned-hours map, keyed by sprint number. Unassigned (no name
 * and no email) and unscheduled (no sprint) tasks are excluded.
 */
export function aggregatePlannedHours(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const name = (r.name || '').trim();
    const email = (r.uniqueName || '').trim();
    if (!name && !email) continue; // unassigned
    if (typeof r.sprint !== 'number') continue; // unscheduled
    const key = (email || name).toLowerCase();
    let dev = byKey.get(key);
    if (!dev) {
      dev = { name: name || email, uniqueName: email || undefined, planned: {} };
      byKey.set(key, dev);
    }
    dev.planned[r.sprint] = (dev.planned[r.sprint] || 0) + (Number(r.planned) || 0);
    if ((!dev.name || dev.name === email) && name) dev.name = name;
  }
  return [...byKey.values()];
}

/**
 * Combine planned hours with capacity (matched by email/uniqueName) into the
 * stored ProjectDeveloper[] shape. Cells are emitted only for sprints with
 * planned > 0. Capacity falls back to a manual default (marked 'estimated').
 */
export function buildDevelopers(plannedDevs, capacityByEmail, opts = {}) {
  const def = opts.defaultCapacity;
  const out = [];
  for (const d of plannedDevs || []) {
    const capMap = d.uniqueName ? capacityByEmail.get(d.uniqueName.toLowerCase()) || null : null;
    const cells = [];
    for (const [sprintStr, planned] of Object.entries(d.planned)) {
      if (!(planned > 0)) continue;
      const sprint = Number(sprintStr);
      let capacity;
      let source;
      if (capMap && capMap[sprint] != null) {
        capacity = capMap[sprint];
        source = 'ado';
      } else if (def != null && def > 0) {
        capacity = def;
        source = 'estimated';
      } else {
        capacity = 0;
        source = 'estimated';
      }
      cells.push({
        sprint,
        planned: Math.round(planned * 10) / 10,
        capacity: Math.round(capacity * 10) / 10,
        source,
      });
    }
    cells.sort((a, b) => a.sprint - b.sprint);
    if (cells.length) out.push({ name: d.name, uniqueName: d.uniqueName, cells });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
