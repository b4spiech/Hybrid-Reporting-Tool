// Shared workstream-row upsert helper, used by BOTH the manual ingest endpoint
// (PUT /api/projects/:id/rows) and the app-owned ADO sync. Pure functions — no
// I/O — so the DB layer wraps them in a transaction.
import crypto from 'node:crypto';

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : fallback;
}

export function nowISO() {
  return new Date().toISOString();
}

export function makeRowId() {
  return 'r' + crypto.randomBytes(5).toString('hex');
}

export function makeProjectId() {
  return 'p' + crypto.randomBytes(6).toString('hex');
}

/**
 * Merge incoming rows into existing workstreams.
 *
 * Matching: by adoId when the incoming row has one and an existing row matches,
 * otherwise by name (case-insensitive). Update on match, append on miss.
 *
 * Per-field rules:
 *  - percentComplete: clamped to 0–100, always set.
 *  - startSprint: updated only when the incoming row supplies a value; otherwise
 *    preserved on an existing row, defaulting to 1 for a new one. (ADO doesn't
 *    define a start, so the sync omits it and never clobbers a human's setting.)
 *  - endSprint: set when it is an integer within 1..sprintCount; otherwise the
 *    row is kept but flagged (sprintUnset) rather than crashing.
 *  - adoId: stored when provided.
 *
 * Options:
 *  - sprintCount: upper bound for a valid endSprint.
 *  - removeStale: when true (sync), drop rows that HAVE an adoId but are absent
 *    from this payload; rows without an adoId (manually added) are always kept.
 *
 * Returns { rows, updated, added, removed, skipped }. Idempotent.
 */
export function upsertRows(existingRows, incomingRows, { sprintCount = 0, removeStale = false } = {}) {
  const rows = (Array.isArray(existingRows) ? existingRows : []).map((r) => ({ ...r }));
  let updated = 0;
  let added = 0;
  let removed = 0;
  let skipped = 0;
  const incomingAdoIds = new Set();

  for (const raw of Array.isArray(incomingRows) ? incomingRows : []) {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      skipped++;
      continue;
    }

    const percentComplete = clampPercent(raw.percentComplete);
    const startProvided =
      raw.startSprint != null && Number.isFinite(Number(raw.startSprint))
        ? positiveInt(raw.startSprint, 1)
        : undefined;
    const endNum = Number(raw.endSprint);
    const endValid = Number.isInteger(endNum) && endNum >= 1 && endNum <= sprintCount;
    const adoId =
      raw.adoId != null && Number.isFinite(Number(raw.adoId)) ? Number(raw.adoId) : undefined;
    if (adoId !== undefined) incomingAdoIds.add(adoId);

    let idx = -1;
    if (adoId !== undefined) idx = rows.findIndex((r) => r.adoId === adoId);
    if (idx === -1) {
      const lower = name.toLowerCase();
      idx = rows.findIndex((r) => String(r.name).trim().toLowerCase() === lower);
    }

    if (idx !== -1) {
      const next = { ...rows[idx], percentComplete };
      if (startProvided !== undefined) next.startSprint = startProvided;
      if (endValid) {
        next.endSprint = endNum;
        delete next.sprintUnset;
      } else {
        next.sprintUnset = true; // keep the existing endSprint, just flag it
      }
      if (adoId !== undefined) next.adoId = adoId;
      rows[idx] = next;
      updated++;
    } else {
      const start = startProvided !== undefined ? startProvided : 1;
      const row = {
        id: makeRowId(),
        name,
        startSprint: start,
        endSprint: endValid ? endNum : start,
        percentComplete,
      };
      if (!endValid) row.sprintUnset = true;
      if (adoId !== undefined) row.adoId = adoId;
      rows.push(row);
      added++;
    }
  }

  let finalRows = rows;
  if (removeStale) {
    finalRows = rows.filter((r) => {
      if (r.adoId == null) return true; // keep manually-added rows
      if (incomingAdoIds.has(r.adoId)) return true;
      removed++;
      return false;
    });
  }

  return { rows: finalRows, updated, added, removed, skipped };
}
