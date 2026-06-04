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
  - `PUT /api/projects/:id/rows` → bulk-upsert one project's workstream rows from an
    ADO-shaped array (manual ingest path, e.g. Power Automate). Service-token auth.
  - `POST /api/sync` → run the app-owned ADO sync now; returns a per-project summary.
    Service-token auth.
- Auth: when `APP_USER` **and** `APP_PASSWORD` are set, HTTP basic auth gates every
  human route (UI + `/api/state`). The two machine routes above bypass basic auth and
  instead require the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers to
  match `CF_ACCESS_CLIENT_*` (timing-safe; fail closed if unset).

## Azure DevOps sync

When `ADO_PAT` and `ADO_ORG` are set, the server pulls rolled-up work items from ADO
Analytics on a schedule (`ADO_SYNC_CRON`, default hourly) and after boot, and upserts
them into matching app projects — creating a project to mirror an ADO project when one
doesn't exist (bound by `adoProjectGuid`, falling back to `adoProjectName`). The level
displayed defaults to **Feature** (`ADO_ITEM_TYPE`); task hours beneath it (through its
child stories) still roll up via the `Task` aggregate. Per item: `endSprint` comes from
an `IterationName` like "Sprint 10", `percentComplete` from completed / (completed +
remaining) task hours; `startSprint` is left to the human.
Rows with an `adoId` that disappear from ADO are pruned; manually-added rows are kept.
The same shared upsert helper backs both the sync and `PUT /api/projects/:id/rows`. If
`ADO_PAT`/`ADO_ORG` are unset, syncing is disabled (logged, never crashes).

The sprint axis is driven by ADO's real iteration dates: each sync pulls the project's
Iterations, keeps the "Sprint N" ones with start/end dates, and stores their real
per-sprint dates. The chart's labels, column widths (proportional to each sprint's
actual length, so non-uniform sprints differ in width), today line, and milestone dates
all come from these. The manual "Start date" / "Default duration" fields are only a
fallback, used when a project has no ADO sprint dates.

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
- **Schedule risk** — a per-project burndown schematic (reached from the toolbar):
  projects the milestone date forward from today across a best→worst delivery-rate
  corridor, with a what-if slider defaulting to the observed rate, three date cards,
  and a risk sentence. Rates / milestone name / post-sprint weeks are manual inputs
  persisted per project; remaining/completed hours come from the ADO sync.
- **Present mode** — hides editing UI for screen-sharing.
- **Today override** — pin "today" to any date for what-if / demo views.

## Layout

`server/index.js` Express + Postgres (`pg`) backend, basic auth, serves `dist/` +
`/api` · `src/store.ts` ProjectStore +
LocalStorageStore · `src/apiStore.ts` backend-backed store · `src/storage.ts`
defaults / normalization / migration · `src/dates.ts` · `src/sprints.ts` timeline +
date↔pixel mapping · `src/variance.ts` · `src/excel.ts` xlsx parse + merge ·
`src/exporters.ts` PNG · `src/components/` chart, project bar, config panel, rows table.
