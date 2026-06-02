# Hybrid-Reporting-Tool

A **tracking Gantt** for hybrid programs — one row per workstream, each a
horizontal bar from a start sprint to a completion milestone, shaded by % work
done, with a dashed "today" line cutting across all rows. Holds many independent
projects. Built for weekly leadership status updates.

The source of truth is a small local backend with a **SQLite file on disk**, so
your data survives a browser cache wipe. Backing up is just copying one file:
`./data/gantt.sqlite`.

## Run

```bash
npm install
npm run dev      # backend + Vite together; open http://localhost:5173
```

`npm run dev` uses `concurrently` to start:
- the **backend** (Express + better-sqlite3) on **http://localhost:8787**, and
- the **Vite** dev server on **http://localhost:5173**, which proxies `/api` to 8787.

Production (single origin, e.g. behind a Cloudflare Tunnel):

```bash
npm run build    # static frontend -> dist/
npm start        # backend serves dist/ AND /api on http://localhost:8787
```

## Data & backup

- Database file: **`./data/gantt.sqlite`** (the `data/` folder is created on first
  run and is git-ignored). Override the port with `PORT=… npm run server`.
- Schema is intentionally migration-free — each project is stored as a JSON blob:
  - `projects(id, name, data, created_at, updated_at)` — `data` is the full `Project` JSON.
  - `app_meta(key, value)` — holds `activeProjectId`.
- **Back up / restore: copy `./data/gantt.sqlite`.** It uses the default rollback
  journal, so the single file is always complete after a save (no sidecar files).

### REST API

- `GET /api/state` → `{ projects: Project[], activeProjectId: string | null }`
- `PUT /api/state` → accepts the full `AppState`; replaces all projects and sets
  `activeProjectId` in one transaction.

### Persistence flow

The frontend talks only to the `ProjectStore` interface. `ApiStore` is the source
of truth: it loads via `GET /api/state` and saves via a ~500ms-debounced
`PUT /api/state`. `LocalStorageStore` remains as a write-through cache + offline
fallback when the backend is unreachable. **One-time migration:** on first run, if
the database is empty but localStorage holds existing projects, they are pushed up
to the backend so nothing is lost.

## How it works

- **Projects** — a dropdown selector plus New / Rename / Duplicate / Delete
  (delete confirms inline). Each project keeps its own sprints, workstreams,
  percentages, and today setting; the last-used project reopens on reload.
- **Sprint configuration** — start date, number of sprints, default duration in
  **weeks** (every sprint spans `weeks × 7` days), and the milestone finish rule
  (last working day = Friday, or last calendar day). Changes recompute all sprint
  dates and re-render instantly.
- **Workstreams table** — add / edit / delete rows (name, start sprint, completion
  sprint, % complete, notes). Edits update the chart live.
- **Chart (inline SVG)** — S1..SN columns with finish dates, faint sprint
  boundaries, a white track bar per row, a medium-blue fill for work done with a
  `NN%` label, a dark-blue diamond at the completion sprint, and the dashed
  "today" line. Blue + white palette; the UI chrome is dark-mode aware while the
  chart stays white "paper" for consistent exports.
- **Variance** — bar length is schedule, shading is work. While a row is in flight,
  the gap between the shaded edge and the today line is reported in whole sprints
  (`+1 sprint` / `−2 sprints` / on track); behind rows get a light-blue tint.
- **Export PNG** — exports the chart only at 2× on a white background, named
  `"<project name> - <YYYY-MM-DD>.png"`.
- **Import Excel** — `.xlsx` (SheetJS, lazy-loaded). Reads the first worksheet with
  headers `Name, Start sprint, Completion sprint, % complete, Notes` (tolerant of
  case/spacing), matches workstreams by name to update or adds new ones, clamps %
  to 0–100, skips blank rows, and flags out-of-range sprints. Active project only.
- **Present mode** — hides editing UI for screen-sharing.
- **Today override** — pin "today" to any date for what-if / demo views.

## Layout

`server/index.js` Express + better-sqlite3 backend · `src/store.ts` ProjectStore +
LocalStorageStore · `src/apiStore.ts` backend-backed store · `src/storage.ts`
defaults / normalization / migration · `src/dates.ts` · `src/sprints.ts` timeline +
date↔pixel mapping · `src/variance.ts` · `src/excel.ts` xlsx parse + merge ·
`src/exporters.ts` PNG · `src/components/` chart, project bar, config panel, rows table.
