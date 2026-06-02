// Local backend: a tiny Express + better-sqlite3 service that is the source of
// truth for all project data. The whole AppState is mirrored to one SQLite file
// on disk, so backing up your data is just copying ./data/gantt.sqlite.
import express from 'express';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'gantt.sqlite');
const PORT = Number(process.env.PORT) || 8787;

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
// Default (DELETE) journal keeps everything in the single .sqlite file after
// each commit, so backing up is just copying ./data/gantt.sqlite.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    data TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Prepared statements ---------------------------------------------------
const selectProjects = db.prepare('SELECT data FROM projects ORDER BY created_at ASC');
const selectMeta = db.prepare("SELECT value FROM app_meta WHERE key = 'activeProjectId'");
const deleteAllProjects = db.prepare('DELETE FROM projects');
const insertProject = db.prepare(`
  INSERT INTO projects (id, name, data, created_at, updated_at)
  VALUES (@id, @name, @data, @created_at, @updated_at)
`);
const upsertMeta = db.prepare(`
  INSERT INTO app_meta (key, value) VALUES ('activeProjectId', @value)
  ON CONFLICT(key) DO UPDATE SET value = @value
`);

/** Full-state write, atomic: replace the project set and set activeProjectId. */
const writeState = db.transaction((state) => {
  deleteAllProjects.run();
  for (const project of state.projects) {
    insertProject.run({
      id: String(project.id),
      name: typeof project.name === 'string' ? project.name : '',
      data: JSON.stringify(project),
      created_at: typeof project.createdAt === 'string' ? project.createdAt : '',
      updated_at: typeof project.updatedAt === 'string' ? project.updatedAt : '',
    });
  }
  upsertMeta.run({ value: state.activeProjectId == null ? null : String(state.activeProjectId) });
});

function readState() {
  const projects = selectProjects.all().map((row) => JSON.parse(row.data));
  const meta = selectMeta.get();
  return { projects, activeProjectId: meta?.value ?? null };
}

// --- HTTP ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/state', (_req, res) => {
  try {
    res.json(readState());
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'read_failed' });
  }
});

app.put('/api/state', (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.projects)) {
    return res.status(400).json({ error: 'invalid_state' });
  }
  try {
    writeState({
      projects: body.projects,
      activeProjectId: typeof body.activeProjectId === 'string' ? body.activeProjectId : null,
    });
    res.json(readState());
  } catch (err) {
    console.error('PUT /api/state failed', err);
    res.status(500).json({ error: 'write_failed' });
  }
});

// In production, serve the built static frontend from the same origin so the
// whole app (UI + API) runs on this one port behind e.g. a Cloudflare Tunnel.
const DIST = join(ROOT, 'dist');
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA fallback (Express 5: avoid bare '*' route patterns).
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(join(DIST, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Gantt backend listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
