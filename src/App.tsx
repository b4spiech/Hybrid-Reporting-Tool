import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Project, ProjectRisk } from './types';
import {
  defaultAppState,
  makeProject,
  cloneProjectWithNewId,
  makeId,
  exampleRow,
  nowISO,
} from './storage';
import { ApiStore } from './apiStore';
import { parseISO, toISO, todayUTC } from './dates';
import { Gantt } from './components/Gantt';
import { ConfigPanel } from './components/ConfigPanel';
import { RowsTable } from './components/RowsTable';
import { ProjectBar } from './components/ProjectBar';
import { RiskPage } from './components/RiskPage';
import { BurndownPage } from './components/BurndownPage';
import { PresentStats } from './components/PresentStats';
import { exportPNG } from './exporters';
import { readWorkstreamsXlsx, mergeWorkstreams } from './excel';

const store = new ApiStore();

export default function App() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [present, setPresent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState<'gantt' | 'risk' | 'burndown'>('gantt');
  const svgRef = useRef<SVGSVGElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);

  // Load the source of truth (backend) once on mount, seeding a default if the
  // database is brand new.
  useEffect(() => {
    let alive = true;
    store.load().then((loaded) => {
      if (alive) setAppState(loaded ?? defaultAppState());
    });
    return () => {
      alive = false;
    };
  }, []);

  // Auto-save the whole collection on every change (ApiStore debounces).
  useEffect(() => {
    if (appState) store.save(appState);
  }, [appState]);

  const active: Project | null =
    appState?.projects.find((p) => p.id === appState.activeProjectId) ??
    appState?.projects[0] ??
    null;

  const today = useMemo(
    () => (active?.todayOverride ? parseISO(active.todayOverride) : todayUTC()),
    [active?.todayOverride],
  );

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((s) => (s === msg ? null : s)), 3000);
  };

  // --- Active-project mutation -------------------------------------------
  const updateActive = (patch: Partial<Project>) => {
    if (!active) return;
    setAppState((s) =>
      s
        ? {
            ...s,
            projects: s.projects.map((p) =>
              p.id === active.id ? { ...p, ...patch, updatedAt: nowISO() } : p,
            ),
          }
        : s,
    );
  };

  const addRow = () => {
    if (!active) return;
    const row = exampleRow('New workstream', 1, Math.min(active.sprints.sprintCount, 4), 0);
    row.id = makeId();
    updateActive({ rows: [...active.rows, row] });
  };

  const setRisk = (patch: Partial<ProjectRisk>) => {
    if (!active) return;
    updateActive({ risk: { ...(active.risk ?? {}), ...patch } });
  };

  // --- Project management -------------------------------------------------
  const switchProject = (id: string) =>
    setAppState((s) => (s ? { ...s, activeProjectId: id } : s));

  const newProject = () => {
    if (!appState) return;
    const project = makeProject(nextProjectName(appState.projects));
    setAppState((s) => (s ? { projects: [...s.projects, project], activeProjectId: project.id } : s));
    flash(`Created “${project.name}”. Configure its sprints below.`);
  };

  const duplicateProject = () => {
    if (!active) return;
    const copy = cloneProjectWithNewId(active, `${active.name} copy`);
    setAppState((s) => (s ? { projects: [...s.projects, copy], activeProjectId: copy.id } : s));
    flash(`Duplicated “${active.name}”.`);
  };

  const deleteProject = () => {
    if (!active) return;
    setAppState((s) => {
      if (!s) return s;
      const remaining = s.projects.filter((p) => p.id !== active.id);
      if (remaining.length === 0) {
        const seed = makeProject('Project 1');
        return { projects: [seed], activeProjectId: seed.id };
      }
      return { projects: remaining, activeProjectId: remaining[0].id };
    });
    flash(`Deleted “${active.name}”.`);
  };

  const focusRename = () => {
    titleRef.current?.focus();
    titleRef.current?.select();
  };

  // --- Import / export ----------------------------------------------------
  const handleExcelImport = async (file: File) => {
    if (!active) return;
    try {
      const parse = await readWorkstreamsXlsx(file);
      if (parse.rows.length === 0 && parse.blankSkipped === 0) {
        flash('No workstream rows found. Expected headers: Name, Start sprint, Completion sprint, % complete, Notes.');
        return;
      }
      const result = mergeWorkstreams(active.rows, parse, active.sprints.sprintCount);
      updateActive({ rows: result.rows });
      flash(`${result.updated} updated, ${result.added} added, ${result.skipped} skipped.`);
    } catch {
      flash('Could not read that Excel file.');
    }
  };

  const doPNG = () => {
    if (svgRef.current && active)
      exportPNG(svgRef.current, pngFilename(active.name, toISO(today))).catch(() =>
        flash('PNG export failed.'),
      );
  };

  // Pull from Azure DevOps now (recreates app projects that mirror ADO projects,
  // e.g. one you deleted), then reload the collection from the backend.
  const syncFromAdo = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      if (res.status === 503) {
        flash('Azure DevOps sync is not configured on the server.');
      } else if (res.status === 409) {
        flash('A sync is already running — try again shortly.');
      } else if (!res.ok) {
        flash('Sync failed.');
      } else {
        const summary: Array<{ created?: number; updated?: number; added?: number; error?: string }> =
          await res.json();
        const t = summary.reduce<{ created: number; updated: number; added: number; failed: number }>(
          (a, s) => ({
            created: a.created + (s.created || 0),
            updated: a.updated + (s.updated || 0),
            added: a.added + (s.added || 0),
            failed: a.failed + (s.error ? 1 : 0),
          }),
          { created: 0, updated: 0, added: 0, failed: 0 },
        );
        flash(
          `Synced ${summary.length} project${summary.length === 1 ? '' : 's'} — ${t.created} created, ${t.updated} updated, ${t.added} rows added${t.failed ? `, ${t.failed} failed` : ''}.`,
        );
      }
      // Refresh the view from the backend regardless (cheap, also acts as a reload).
      const loaded = await store.load();
      if (loaded) setAppState(loaded);
    } catch {
      flash('Sync failed — could not reach the server.');
    } finally {
      setSyncing(false);
    }
  };

  if (!appState) {
    return (
      <div className="app">
        <div className="loading">Loading…</div>
      </div>
    );
  }
  if (!active) return null;

  return (
    <div className={`app${present ? ' present' : ''}`}>
      <header className="topbar">
        <ProjectBar
          projects={appState.projects}
          activeId={active.id}
          present={present}
          onSwitch={switchProject}
          onNew={newProject}
          onDuplicate={duplicateProject}
          onRename={focusRename}
          onDelete={deleteProject}
        />

        <div className="topbar-main">
          {present ? (
            <h1 className="title-static">{active.name}</h1>
          ) : (
            <input
              ref={titleRef}
              className="title-input"
              value={active.name}
              onChange={(e) => updateActive({ name: e.target.value })}
              aria-label="Project name"
            />
          )}
          <div className="toolbar">
            {view === 'gantt' && !present && (
              <>
                <button onClick={syncFromAdo} disabled={syncing}>
                  {syncing ? 'Syncing…' : 'Sync from ADO'}
                </button>
                <button onClick={doPNG}>Export PNG</button>
                <button onClick={() => xlsxInputRef.current?.click()}>Import Excel</button>
                <button onClick={() => setView('risk')}>Schedule risk</button>
                <button onClick={() => setView('burndown')}>Burndown</button>
              </>
            )}
            {view === 'gantt' && (
              <button className={present ? 'primary' : ''} onClick={() => setPresent((p) => !p)}>
                {present ? 'Exit present mode' : 'Present mode'}
              </button>
            )}
          </div>
        </div>

        <input
          ref={xlsxInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleExcelImport(f);
            e.target.value = '';
          }}
        />
      </header>

      {status && <div className="status-toast">{status}</div>}

      <main>
        {view === 'risk' ? (
          <RiskPage project={active} today={today} onRiskChange={setRisk} onBack={() => setView('gantt')} />
        ) : view === 'burndown' ? (
          <BurndownPage project={active} today={today} onBack={() => setView('gantt')} />
        ) : (
          <>
            <div className="chart-card">
              <Gantt ref={svgRef} sprintsConfig={active.sprints} rows={active.rows} today={today} present={present} />
            </div>

            {present && <PresentStats project={active} today={today} />}

            {!present && (
              <div className="editors">
                <ConfigPanel
                  config={active.sprints}
                  onChange={(sprints) => updateActive({ sprints })}
                  todayOverride={active.todayOverride}
                  onTodayOverrideChange={(v) => updateActive({ todayOverride: v })}
                  description={active.description}
                  aliases={active.aliases}
                  onDescriptionChange={(description) => updateActive({ description })}
                  onAliasesChange={(aliases) => updateActive({ aliases })}
                />
                <RowsTable
                  rows={active.rows}
                  sprintCount={active.sprints.sprintCount}
                  onChange={(rows) => updateActive({ rows })}
                  onAdd={addRow}
                />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** "<project name> - <YYYY-MM-DD>.png", sanitized of filesystem-illegal chars. */
function pngFilename(name: string, dateISO: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'tracking-gantt';
  return `${safe} - ${dateISO}.png`;
}

function nextProjectName(projects: Project[]): string {
  const names = new Set(projects.map((p) => p.name));
  let n = projects.length + 1;
  let name = `Project ${n}`;
  while (names.has(name)) {
    n++;
    name = `Project ${n}`;
  }
  return name;
}
