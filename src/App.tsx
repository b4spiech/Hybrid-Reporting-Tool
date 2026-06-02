import { useEffect, useMemo, useRef, useState } from 'react';
import type { GanttRow, ProjectState } from './types';
import { loadState, saveState, normalize, makeId, exampleRow } from './storage';
import { parseISO, todayUTC } from './dates';
import { Gantt } from './components/Gantt';
import { ConfigPanel } from './components/ConfigPanel';
import { RowsTable } from './components/RowsTable';
import {
  exportJSON,
  exportPNG,
  exportSVG,
  parseProgressCSV,
  readFileText,
} from './exporters';

export default function App() {
  const [state, setState] = useState<ProjectState>(() => loadState());
  const [present, setPresent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Auto-save to localStorage on every change.
  useEffect(() => {
    saveState(state);
  }, [state]);

  const today = useMemo(
    () => (state.todayOverride ? parseISO(state.todayOverride) : todayUTC()),
    [state.todayOverride],
  );

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus((s) => (s === msg ? null : s)), 3000);
  };

  const patch = (p: Partial<ProjectState>) => setState((s) => ({ ...s, ...p }));

  const addRow = () => {
    const next = exampleRow('New workstream', 1, Math.min(state.sprints.sprintCount, 4), 0);
    next.id = makeId();
    patch({ rows: [...state.rows, next] });
  };

  const handleJSONImport = async (file: File) => {
    try {
      const text = await readFileText(file);
      setState(normalize(JSON.parse(text)));
      flash('Project imported.');
    } catch {
      flash('Could not read that JSON file.');
    }
  };

  const handleCSVImport = async (file: File) => {
    try {
      const text = await readFileText(file);
      const map = parseProgressCSV(text);
      if (map.size === 0) {
        flash('No “name, percent” rows found in that CSV.');
        return;
      }
      let matched = 0;
      const rows: GanttRow[] = state.rows.map((r) => {
        const pct = map.get(r.name.trim().toLowerCase());
        if (pct === undefined) return r;
        matched++;
        return { ...r, percentComplete: pct };
      });
      patch({ rows });
      flash(`Updated ${matched} of ${state.rows.length} workstream${matched === 1 ? '' : 's'} from CSV.`);
    } catch {
      flash('Could not read that CSV file.');
    }
  };

  const doPNG = () => {
    if (svgRef.current) exportPNG(svgRef.current, state.title).catch(() => flash('PNG export failed.'));
  };
  const doSVG = () => {
    if (svgRef.current) exportSVG(svgRef.current, state.title);
  };

  return (
    <div className={`app${present ? ' present' : ''}`}>
      <header className="topbar">
        {present ? (
          <h1 className="title-static">{state.title}</h1>
        ) : (
          <input
            className="title-input"
            value={state.title}
            onChange={(e) => patch({ title: e.target.value })}
            aria-label="Project title"
          />
        )}
        <div className="toolbar">
          {!present && (
            <>
              <button onClick={doPNG}>Export PNG</button>
              <button onClick={doSVG}>Export SVG</button>
              <button onClick={() => exportJSON(state)}>Export JSON</button>
              <button onClick={() => jsonInputRef.current?.click()}>Import JSON</button>
              <button onClick={() => csvInputRef.current?.click()}>Import CSV</button>
            </>
          )}
          <button className={present ? 'primary' : ''} onClick={() => setPresent((p) => !p)}>
            {present ? 'Exit present mode' : 'Present mode'}
          </button>
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

      {status && <div className="status-toast">{status}</div>}

      <main>
        <div className="chart-card">
          <Gantt ref={svgRef} sprintsConfig={state.sprints} rows={state.rows} today={today} />
        </div>

        {!present && (
          <div className="editors">
            <ConfigPanel
              config={state.sprints}
              onChange={(sprints) => patch({ sprints })}
              todayOverride={state.todayOverride}
              onTodayOverrideChange={(v) => patch({ todayOverride: v })}
            />
            <RowsTable
              rows={state.rows}
              sprintCount={state.sprints.sprintCount}
              onChange={(rows) => patch({ rows })}
              onAdd={addRow}
            />
          </div>
        )}
      </main>
    </div>
  );
}
