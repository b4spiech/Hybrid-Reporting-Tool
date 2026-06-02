import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Project } from './types';
import {
  defaultAppState,
  makeProject,
  cloneProjectWithNewId,
  makeId,
  exampleRow,
  nowISO,
} from './storage';
import { LocalStorageStore } from './store';
import { parseISO, toISO, todayUTC } from './dates';
import { Gantt } from './components/Gantt';
import { ConfigPanel } from './components/ConfigPanel';
import { RowsTable } from './components/RowsTable';
import { ProjectBar } from './components/ProjectBar';
import { exportPNG } from './exporters';
import { readWorkstreamsXlsx, mergeWorkstreams } from './excel';

const store = new LocalStorageStore();

export default function App() {
  const [appState, setAppState] = useState<AppState>(() => store.load() ?? defaultAppState());
  const [present, setPresent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const xlsxInputRef = useRef<HTMLInputElement>(null);

  // Auto-save the whole collection on every change.
  useEffect(() => {
    store.save(appState);
  }, [appState]);

  const active: Project | null =
    appState.projects.find((p) => p.id === appState.activeProjectId) ??
    appState.projects[0] ??
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
    setAppState((s) => ({
      ...s,
      projects: s.projects.map((p) =>
        p.id === active.id ? { ...p, ...patch, updatedAt: nowISO() } : p,
      ),
    }));
  };

  const addRow = () => {
    if (!active) return;
    const row = exampleRow('New workstream', 1, Math.min(active.sprints.sprintCount, 4), 0);
    row.id = makeId();
    updateActive({ rows: [...active.rows, row] });
  };

  // --- Project management -------------------------------------------------
  const switchProject = (id: string) => setAppState((s) => ({ ...s, activeProjectId: id }));

  const newProject = () => {
    const project = makeProject(nextProjectName(appState.projects));
    setAppState((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
    flash(`Created “${project.name}”. Configure its sprints below.`);
  };

  const duplicateProject = () => {
    if (!active) return;
    const copy = cloneProjectWithNewId(active, `${active.name} copy`);
    setAppState((s) => ({ projects: [...s.projects, copy], activeProjectId: copy.id }));
    flash(`Duplicated “${active.name}”.`);
  };

  const deleteProject = () => {
    if (!active) return;
    setAppState((s) => {
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
            {!present && (
              <>
                <button onClick={doPNG}>Export PNG</button>
                <button onClick={() => xlsxInputRef.current?.click()}>Import Excel</button>
              </>
            )}
            <button className={present ? 'primary' : ''} onClick={() => setPresent((p) => !p)}>
              {present ? 'Exit present mode' : 'Present mode'}
            </button>
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
        <div className="chart-card">
          <Gantt ref={svgRef} sprintsConfig={active.sprints} rows={active.rows} today={today} />
        </div>

        {!present && (
          <div className="editors">
            <ConfigPanel
              config={active.sprints}
              onChange={(sprints) => updateActive({ sprints })}
              todayOverride={active.todayOverride}
              onTodayOverrideChange={(v) => updateActive({ todayOverride: v })}
            />
            <RowsTable
              rows={active.rows}
              sprintCount={active.sprints.sprintCount}
              onChange={(rows) => updateActive({ rows })}
              onAdd={addRow}
            />
          </div>
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
