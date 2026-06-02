# Hybrid-Reporting-Tool

A single-page **tracking Gantt** for hybrid programs — one row per workstream, each
a horizontal bar from a start sprint to a completion milestone, shaded by % work
done, with a dashed "today" line cutting across all rows. Built for weekly
leadership status updates.

No backend. State persists to `localStorage` and round-trips through JSON
export/import. Builds to a static bundle (host it anywhere — e.g. Cloudflare Tunnel).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build -> dist/
npm run preview  # serve the built bundle
```

## How it works

- **Sprint configuration** — start date, sprint count, default duration, and
  per-sprint duration overrides. Each sprint's milestone finish date is either the
  last working day (Friday) or the last calendar day. Changing any of these
  recomputes every sprint's dates and re-renders instantly.
- **Workstreams table** — add / edit / delete rows (name, start sprint, completion
  sprint, % complete, notes). Edits update the chart live.
- **Chart (inline SVG)** — S1..SN columns with finish dates, faint sprint
  boundaries, a neutral track bar per row, a teal fill for work done, a diamond at
  the completion sprint, and the dashed "today" line.
- **Variance** — bar length is schedule, shading is work. When the shaded edge sits
  behind today the remaining segment is tinted amber with a `−Nd / −1 sprint` badge;
  ahead is tinted green. Understated by design.
- **Export / import** — PNG, SVG, and full-state JSON. CSV import maps
  `name,percent` rows onto matching workstreams (paste your Azure DevOps rollup).
- **Present mode** — hides all editing UI for screen-sharing.
- **Today override** — pin "today" to any date for what-if / demo views.

## Layout

`src/dates.ts` date-only helpers · `src/sprints.ts` sprint timeline + date↔pixel
mapping · `src/variance.ts` schedule-vs-work comparison · `src/storage.ts`
persistence + normalization · `src/exporters.ts` PNG/SVG/JSON/CSV ·
`src/components/` chart, config panel, rows table.
