# Hybrid-Reporting-Tool

A **tracking Gantt** for hybrid programs — one row per workstream, each a
horizontal bar from a start sprint to a completion milestone, shaded by % work
done, with a dashed "today" line cutting across all rows. Holds many independent
projects. Built for weekly leadership status updates.

The source of truth is a small Express backend backed by **managed Postgres**, so
your data lives in a real database. The same backend serves the built frontend and
the API on one port — it deploys as a **single Railway service**.

## Run locally

```bash
npm install
cp .env.example .env     # set DATABASE_URL to a local/remote Postgres
npm run dev              # backend + Vite together; open http://localhost:5173
```

`npm run dev` uses `concurrently` to start:
- the **backend** (Express + `pg`) on **http://localhost:8787**, and
- the **Vite** dev server on **http://localhost:5173**, which proxies `/api` to 8787.

If `DATABASE_URL` isn't reachable, the backend won't serve the API and the UI
transparently falls back to `localStorage` (see persistence flow below).

A throwaway local Postgres for development:

```bash
docker run -d --name gantt-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=gantt \
  -p 5432:5432 postgres:16-alpine
# DATABASE_URL=postgres://postgres:secret@localhost:5432/gantt
```

## Deploy on Railway (single service)

1. Add the **Postgres** plugin to your Railway project.
2. Deploy this repo as a service. `railway.json` sets build `npm run build` and
   start `npm start`; the server serves `dist/` + `/api` on `process.env.PORT`
   (bound to `0.0.0.0`).
3. Set service variables (see `.env.example`):
   - `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (reference the plugin)
   - `APP_USER` / `APP_PASSWORD` — basic-auth credentials (strongly recommended on
     a public URL; if unset, the app is open and logs a startup warning)
   - `PORT` is provided by Railway; `DATABASE_SSL` only if you need to override the
     auto policy.

`npm start` also works anywhere else (any host with `DATABASE_URL` set).

## Database & API

- Postgres, schema created on startup (`CREATE TABLE IF NOT EXISTS`, no migration tool):
  - `projects(id TEXT PK, name TEXT, data JSONB, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)`
    — `data` is the full `Project` object.
  - `app_meta(key TEXT PK, value TEXT)` — holds `activeProjectId`.
- SSL: auto — off for `localhost`/`*.railway.internal`, relaxed-on for public hosts;
  override with `DATABASE_SSL=true|false`.
- REST:
  - `GET /api/state` → `{ projects: Project[], activeProjectId: string | null }`
  - `PUT /api/state` → accepts the full `AppState`; replaces all projects and sets
    `activeProjectId` in one transaction.
- Auth: when `APP_USER` **and** `APP_PASSWORD` are set, HTTP basic auth gates every
  route (UI + `/api`).

### Persistence flow

The frontend talks only to the `ProjectStore` interface. `ApiStore` is the source
of truth: it loads via `GET /api/state` and saves via a ~500ms-debounced
`PUT /api/state`. `LocalStorageStore` remains as a write-through cache + offline
fallback when the backend is unreachable. **One-time migration:** on first run, if
the database is empty but localStorage holds existing projects, they are pushed up
to the backend so nothing is lost (this also carries data over from the earlier
local-SQLite build, since that data lives in localStorage as the cache).

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

`server/index.js` Express + Postgres (`pg`) backend, basic auth, serves `dist/` +
`/api` · `src/store.ts` ProjectStore +
LocalStorageStore · `src/apiStore.ts` backend-backed store · `src/storage.ts`
defaults / normalization / migration · `src/dates.ts` · `src/sprints.ts` timeline +
date↔pixel mapping · `src/variance.ts` · `src/excel.ts` xlsx parse + merge ·
`src/exporters.ts` PNG · `src/components/` chart, project bar, config panel, rows table.
