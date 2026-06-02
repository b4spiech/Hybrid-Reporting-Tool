import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, GanttRow, Project } from './types';
import {
  defaultAppState,
  makeProject,
  cloneProjectWithNewId,
  projectsFromImport,
  makeId,
  exampleRow,
  nowISO,
} from './storage';
import { LocalStorageStore } from './store';
import { parseISO, todayUTC } from './dates';
import { Gantt } from './components/Gantt';
import { ConfigPanel } from './components/ConfigPanel';
import { RowsTable } from './components/RowsTable';
import { ProjectBar } from './components/ProjectBar';
import {
  exportProjectJSON,
  exportCollectionJSON,
  exportPNG,
  exportSVG,
  parseProgressCSV,
  readFileText,
} from './exporters';

const store = new LocalStorageStore();

type PendingImport = { projects: Project[]; wasCollection: boolean };

export default function App() {
  const [appState, setAppState] = useState<AppState>(() => store.load() ?? defaultAppState());
  const [present, setPresent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

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
  const handleJSONImport = async (file: File) => {
    try {
      const text = await readFileText(file);
      const result = projectsFromImport(JSON.parse(text));
      if (result.projects.length === 0) {
        flash('No projects found in that JSON file.');
        return;
      }
      setPendingImport(result);
    } catch {
      flash('Could not read that JSON file.');
    }
  };

  const applyImport = (mode: 'replace' | 'merge') => {
    if (!pendingImport) return;
    const incoming = pendingImport.projects;
    if (mode === 'replace') {
      setAppState({ projects: incoming, activeProjectId: incoming[0].id });
      flash(`Replaced all projects with ${incoming.length} imported project${plural(incoming.length)}.`);
    } else {
      // Fresh ids so a merge never collides with existing projects.
      const added = incoming.map((p) => cloneProjectWithNewId(p, p.name));
      setAppState((s) => ({
        projects: [...s.projects, ...added],
        activeProjectId: added[0].id,
      }));
      flash(`Added ${added.length} imported project${plural(added.length)}.`);
    }
    setPendingImport(null);
  };

  const handleCSVImport = async (file: File) => {
    if (!active) return;
    try {
      const text = await readFileText(file);
      const map = parseProgressCSV(text);
      if (map.size === 0) {
        flash('No “name, percent” rows found in that CSV.');
        return;
      }
      let matched = 0;
      const rows: GanttRow[] = active.rows.map((r) => {
        const pct = map.get(r.name.trim().toLowerCase());
        if (pct === undefined) return r;
        matched++;
        return { ...r, percentComplete: pct };
      });
      updateActive({ rows });
      flash(`Updated ${matched} of ${active.rows.length} workstream${plural(active.rows.length)} from CSV.`);
    } catch {
      flash('Could not read that CSV file.');
    }
  };

  const doPNG = () => {
    if (svgRef.current && active)
      exportPNG(svgRef.current, active.name).catch(() => flash('PNG export failed.'));
  };
  const doSVG = () => {
    if (svgRef.current && active) exportSVG(svgRef.current, active.name);
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
                <button onClick={doSVG}>Export SVG</button>
                <button onClick={() => exportProjectJSON(active)}>Export project</button>
                <button onClick={() => exportCollectionJSON(appState)}>Export all</button>
                <button onClick={() => jsonInputRef.current?.click()}>Import JSON</button>
                <button onClick={() => csvInputRef.current?.click()}>Import CSV</button>
              </>
            )}
            <button className={present ? 'primary' : ''} onClick={() => setPresent((p) => !p)}>
              {present ? 'Exit present mode' : 'Present mode'}
            </button>
          </div>
        </div>

        <input
          ref={jsonInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleJSONImport(f);
            e.target.value = '';
          }}
        />
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleCSVImport(f);
            e.target.value = '';
          }}
        />
      </header>

      {pendingImport && (
        <div className="import-prompt">
          <span>
            {pendingImport.wasCollection
              ? `Import a collection of ${pendingImport.projects.length} project${plural(
                  pendingImport.projects.length,
                )}.`
              : `Import “${pendingImport.projects[0].name}”.`}{' '}
            Replace all current projects, or merge them in?
          </span>
          <div className="import-actions">
            <button className="danger-solid" onClick={() => applyImport('replace')}>
              Replace all
            </button>
            <button className="primary" onClick={() => applyImport('merge')}>
              Merge (add)
            </button>
            <button onClick={() => setPendingImport(null)}>Cancel</button>
          </div>
        </div>
      )}

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

function plural(n: number): string {
  return n === 1 ? '' : 's';
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
