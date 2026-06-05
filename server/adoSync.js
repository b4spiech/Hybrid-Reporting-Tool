// App-owned Azure DevOps sync: pulls rolled-up work items (Feature level by
// default, configurable via ADO_ITEM_TYPE) from ADO Analytics, maps each to a
// workstream row, and upserts them into the app's own projects
// (creating a project to mirror an ADO project when none exists). Uses the
// shared row-upsert helper so the merge logic matches the ingest endpoint.
import { upsertRows, makeProjectId, clampPercent, nowISO } from './rows.js';

const ANALYTICS_BASE = process.env.ADO_ANALYTICS_BASE || 'https://analytics.dev.azure.com';

export function adoConfigured() {
  return Boolean(process.env.ADO_PAT && process.env.ADO_ORG);
}

function authHeaders() {
  const token = Buffer.from('pat:' + (process.env.ADO_PAT || '')).toString('base64');
  return { Authorization: 'Basic ' + token, Accept: 'application/json' };
}

function projectNamesFromEnv() {
  return (process.env.ADO_PROJECTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fetch an OData collection, following @odata.nextLink pagination. */
async function fetchAllOData(url) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ADO OData ${res.status} ${res.statusText}${body ? ': ' + body.slice(0, 300) : ''}`);
    }
    const json = await res.json();
    if (Array.isArray(json.value)) out.push(...json.value);
    next = json['@odata.nextLink'] || null;
  }
  return out;
}

/**
 * Resolve the ADO project list + GUIDs from the Analytics Projects feed. If
 * ADO_PROJECTS is set, filter to those names (case-insensitive). If the feed is
 * unavailable to the token, fall back to the ADO_PROJECTS names (no GUID).
 */
export async function resolveAdoProjects() {
  const org = process.env.ADO_ORG;
  const names = projectNamesFromEnv();
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(org)}/_odata/v4.0-preview/Projects?$select=ProjectId,ProjectName`;
  try {
    const rows = await fetchAllOData(url);
    let projects = rows
      .filter((r) => r && typeof r.ProjectName === 'string')
      .map((r) => ({ guid: typeof r.ProjectId === 'string' ? r.ProjectId : undefined, name: r.ProjectName }));
    if (names.length) {
      const want = new Set(names.map((n) => n.toLowerCase()));
      projects = projects.filter((p) => want.has(p.name.toLowerCase()));
    }
    return projects;
  } catch (err) {
    if (names.length) {
      console.warn(`ADO sync: Projects feed unavailable (${err.message}); using ADO_PROJECTS names as binding keys.`);
      return names.map((name) => ({ guid: undefined, name }));
    }
    throw new Error(`Cannot resolve ADO projects: Projects feed failed and ADO_PROJECTS is unset (${err.message})`);
  }
}

/**
 * Pull the displayed items (Feature level by default, configurable via
 * ADO_ITEM_TYPE) for one project, expanding their descendants with the fields
 * and iteration needed to compute the bar in code. Descendants returns stories
 * AND tasks; the row mapping filters to tasks. Both the schedule (start/end
 * sprint, from the tasks' iterations) and the rollup (task hours) come from the
 * tasks, so the displayed item itself need not be parked in any sprint.
 */
export async function fetchProjectStories(projectName) {
  const org = process.env.ADO_ORG;
  const itemType = (process.env.ADO_ITEM_TYPE || 'Feature').trim() || 'Feature';
  const params = new URLSearchParams();
  params.set('$filter', `WorkItemType eq '${itemType}' and State ne 'Removed' and Descendants/any()`);
  params.set('$select', 'WorkItemId,Title,State');
  params.set(
    '$expand',
    'Descendants($select=WorkItemId,WorkItemType,CompletedWork,RemainingWork,OriginalEstimate;' +
      '$expand=Iteration($select=IterationName))',
  );
  const qs = params.toString().replace(/\+/g, '%20');
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_odata/v4.0-preview/WorkItems?${qs}`;
  return fetchAllOData(url);
}

/**
 * Daily total Task hours across a project's date range (the burndown source).
 * WorkItemSnapshot is an Analytics entity, so the existing Analytics-Read PAT
 * covers it. Returns one row per day: { DateValue, TotalRemaining, TotalCompleted }.
 */
export async function fetchWorkItemSnapshots(projectName, startDate, endDate) {
  const org = process.env.ADO_ORG;
  const parts = ["WorkItemType eq 'Task'"];
  if (startDate) parts.push(`DateValue ge ${startDate}`); // Edm.Date literal (no quotes)
  if (endDate) parts.push(`DateValue le ${endDate}`);
  const apply =
    `filter(${parts.join(' and ')})` +
    `/groupby((DateValue), aggregate(RemainingWork with sum as TotalRemaining, CompletedWork with sum as TotalCompleted))`;
  const params = new URLSearchParams();
  params.set('$apply', apply);
  const qs = params.toString().replace(/\+/g, '%20');
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_odata/v4.0-preview/WorkItemSnapshot?${qs}`;
  return fetchAllOData(url);
}

/** "Sprint 10" -> 10; anything not starting with "Sprint" (or no trailing int) -> undefined. */
export function parseSprintNumber(iterationName) {
  if (typeof iterationName !== 'string') return undefined;
  const t = iterationName.trim();
  if (!/^sprint/i.test(t)) return undefined;
  const m = t.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Map one displayed item (e.g. a Feature) to an upsert row, computing both the
 * bar and the rollup from its descendant TASKS:
 *  - startSprint / endSprint = MIN / MAX sprint number across tasks whose
 *    IterationName starts with "Sprint" (earliest..latest scheduled task).
 *  - percentComplete = completed / (completed + remaining) task hours.
 * A feature with no sprint-assigned tasks is left unscheduled (no start/end), so
 * the upsert flags it (sprintUnset) and the chart draws no bar — no guessing.
 */
export function storyToRow(item) {
  const name = typeof item?.Title === 'string' ? item.Title.trim() : '';
  const adoId =
    item?.WorkItemId != null && Number.isFinite(Number(item.WorkItemId))
      ? Number(item.WorkItemId)
      : undefined;

  const descendants = Array.isArray(item?.Descendants) ? item.Descendants : [];
  const tasks = descendants.filter((d) => d?.WorkItemType === 'Task');

  let completed = 0;
  let remaining = 0;
  const sprints = [];
  for (const task of tasks) {
    completed += Number(task.CompletedWork) || 0;
    remaining += Number(task.RemainingWork) || 0;
    const s = parseSprintNumber(task.Iteration?.IterationName);
    if (typeof s === 'number') sprints.push(s);
  }

  const percentComplete = completed + remaining > 0 ? Math.round((completed / (completed + remaining)) * 100) : 0;

  const row = { name, percentComplete: clampPercent(percentComplete) };
  if (adoId !== undefined) row.adoId = adoId;
  if (sprints.length) {
    row.startSprint = Math.min(...sprints);
    row.endSprint = Math.max(...sprints);
  }
  return row;
}

/** Pull a project's iterations (for the real sprint-date axis). */
export async function fetchProjectIterations(projectName) {
  const org = process.env.ADO_ORG;
  const params = new URLSearchParams();
  params.set('$select', 'IterationName,StartDate,EndDate,IterationPath');
  const qs = params.toString().replace(/\+/g, '%20');
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(org)}/${encodeURIComponent(projectName)}/_odata/v4.0-preview/Iterations?${qs}`;
  return fetchAllOData(url);
}

/**
 * Build the real sprint-date axis from ADO iterations: keep only "Sprint N"
 * iterations with non-null start/end dates, ordered by start date. Each entry
 * carries the parsed sprint number, name, and real start/end (date-only ISO).
 */
export function buildSprintDates(iterations) {
  const out = [];
  for (const it of Array.isArray(iterations) ? iterations : []) {
    const name = typeof it?.IterationName === 'string' ? it.IterationName : '';
    const number = parseSprintNumber(name);
    if (number === undefined) continue; // keep only "Sprint N"
    const start = it?.StartDate;
    const end = it?.EndDate;
    if (!start || !end) continue; // need real dates
    out.push({ number, name, start: String(start).slice(0, 10), end: String(end).slice(0, 10) });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

function findBoundProject(projects, ado) {
  if (ado.guid) {
    const byGuid = projects.find((p) => p.adoProjectGuid && p.adoProjectGuid === ado.guid);
    if (byGuid) return byGuid;
  }
  const lower = ado.name.toLowerCase();
  return projects.find((p) => p.adoProjectName && p.adoProjectName.toLowerCase() === lower);
}

function makeAppProject({ org, name, guid, sprintCount }) {
  const ts = nowISO();
  return {
    id: makeProjectId(),
    name,
    sprints: {
      startDate: '2026-01-05', // a Monday; same default the rest of the app uses
      sprintCount: Math.max(1, sprintCount),
      defaultDurationWeeks: 1,
      endConvention: 'lastWorkingDay',
    },
    rows: [],
    createdAt: ts,
    updatedAt: ts,
    adoOrg: org,
    adoProjectName: name,
    adoProjectGuid: guid,
  };
}

/**
 * Run a full sync. `readState`/`writeState` are the Postgres store functions
 * (same path as every other write). `listProjects`/`fetchStories` are injectable
 * for testing; they default to the real ADO calls. Returns a per-project summary.
 */
export async function runSync({
  readState,
  writeState,
  listProjects = resolveAdoProjects,
  fetchStories = fetchProjectStories,
  fetchIterations = fetchProjectIterations,
  log = console,
}) {
  if (!adoConfigured()) {
    log.warn?.('ADO sync skipped: ADO_PAT/ADO_ORG not set.');
    return [];
  }
  const org = process.env.ADO_ORG;
  const state = await readState();
  // Work on a deep-ish copy so a per-project failure can't leave half-mutated state.
  const projects = state.projects.map((p) => ({
    ...p,
    sprints: { ...p.sprints },
    rows: (p.rows || []).map((r) => ({ ...r })),
  }));

  const adoProjects = await listProjects();
  const summaries = [];

  for (const ado of adoProjects) {
    try {
      const stories = await fetchStories(ado.name);
      const incoming = stories.map(storyToRow).filter((r) => r.name); // skip blank titles

      // Project-level task-hour totals (sum across all features' tasks).
      let totalCompletedHrs = 0;
      let totalRemainingHrs = 0;
      for (const story of stories) {
        const descendants = Array.isArray(story?.Descendants) ? story.Descendants : [];
        for (const d of descendants) {
          if (d?.WorkItemType !== 'Task') continue;
          totalCompletedHrs += Number(d.CompletedWork) || 0;
          totalRemainingHrs += Number(d.RemainingWork) || 0;
        }
      }

      const maxEnd = incoming.reduce(
        (m, r) => (typeof r.endSprint === 'number' ? Math.max(m, r.endSprint) : m),
        0,
      );

      // Real sprint-date axis. A failure here only skips the date refresh (keeps
      // the existing/fallback axis) — it must not block the row upsert.
      let sprintDates = [];
      try {
        sprintDates = buildSprintDates(await fetchIterations(ado.name));
      } catch (e) {
        log.warn?.(`ADO sync: iterations for "${ado.name}" unavailable (${e.message}); keeping current axis.`);
      }
      const maxSprintNo = sprintDates.reduce((m, s) => Math.max(m, Number.isFinite(s.number) ? s.number : 0), 0);
      const wantCount = Math.max(1, maxEnd, maxSprintNo);

      let proj = findBoundProject(projects, ado);
      let created = 0;
      if (!proj) {
        proj = makeAppProject({ org, name: ado.name, guid: ado.guid, sprintCount: wantCount });
        projects.push(proj);
        created = 1;
      } else {
        proj.adoOrg = org;
        proj.adoProjectName = ado.name;
        if (ado.guid) proj.adoProjectGuid = ado.guid;
        // Grow to fit, but never shrink a project's configured sprint count.
        proj.sprints.sprintCount = Math.max(Number(proj.sprints.sprintCount) || 1, wantCount);
      }
      // Refresh the real axis when ADO returned sprint dates this run.
      if (sprintDates.length) proj.sprints.sprintDates = sprintDates;

      const sprintCount = Number(proj.sprints.sprintCount) || 1;
      const res = upsertRows(proj.rows, incoming, { sprintCount, removeStale: true });
      proj.rows = res.rows;
      proj.totalCompletedHrs = Math.round(totalCompletedHrs);
      proj.totalRemainingHrs = Math.round(totalRemainingHrs);
      proj.updatedAt = nowISO();

      summaries.push({
        project: ado.name,
        created,
        updated: res.updated,
        added: res.added,
        removed: res.removed,
        skipped: res.skipped,
      });
    } catch (err) {
      log.error?.(`ADO sync: project "${ado.name}" failed: ${err.message}`);
      summaries.push({
        project: ado.name,
        created: 0,
        updated: 0,
        added: 0,
        removed: 0,
        skipped: 0,
        error: err.message,
      });
    }
  }

  // Set activeProjectId only if none exists yet (don't override a human's choice).
  let activeProjectId = state.activeProjectId;
  if (!activeProjectId || !projects.some((p) => p.id === activeProjectId)) {
    activeProjectId = projects[0]?.id ?? null;
  }

  await writeState({ projects, activeProjectId });

  log.log?.(
    'ADO sync complete: ' +
      (summaries
        .map(
          (s) =>
            `${s.project}[new ${s.created} upd ${s.updated} add ${s.added} rem ${s.removed} skip ${s.skipped}${s.error ? ' ERR' : ''}]`,
        )
        .join(' ') || '(no projects)'),
  );
  return summaries;
}
