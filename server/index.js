// Single Railway service: serves the built frontend (/dist) AND the REST API on
// one port, backed by managed Postgres (the whole AppState is mirrored to two
// tables). Auth-gated with HTTP basic auth when credentials are configured.
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load a local .env in development if present (Railway injects env directly).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine in production
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const PORT = Number(process.env.PORT) || 8787;
const { DATABASE_URL, APP_USER, APP_PASSWORD } = process.env;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Point it at a Postgres instance (see .env.example).');
  process.exit(1);
}

// --- Database --------------------------------------------------------------
const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: sslConfig(DATABASE_URL) });
pool.on('error', (err) => console.error('Postgres pool error', err));

/**
 * SSL policy: explicit DATABASE_SSL wins; otherwise auto — off for local/internal
 * hosts (localhost, *.railway.internal), on (relaxed) for anything public.
 */
function sslConfig(url) {
  const v = (process.env.DATABASE_SSL || '').toLowerCase();
  if (['false', '0', 'disable', 'off'].includes(v)) return false;
  if (['true', '1', 'require', 'on'].includes(v)) return { rejectUnauthorized: false };
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
      return false;
    }
  } catch {
    // fall through
  }
  return { rejectUnauthorized: false };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      data JSONB,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

async function readState() {
  const projects = await pool.query('SELECT data FROM projects ORDER BY created_at ASC NULLS FIRST');
  const meta = await pool.query("SELECT value FROM app_meta WHERE key = 'activeProjectId'");
  return {
    projects: projects.rows.map((r) => r.data), // JSONB -> JS object
    activeProjectId: meta.rows[0]?.value ?? null,
  };
}

/** Full-state write, atomic: replace the project set and set activeProjectId. */
async function writeState(state) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM projects');
    for (const project of state.projects) {
      await client.query(
        'INSERT INTO projects (id, name, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [
          String(project.id),
          typeof project.name === 'string' ? project.name : '',
          project, // node-postgres serializes objects to JSON for a jsonb column
          tsOrNull(project.createdAt),
          tsOrNull(project.updatedAt),
        ],
      );
    }
    await client.query(
      `INSERT INTO app_meta (key, value) VALUES ('activeProjectId', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [state.activeProjectId ?? null],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function tsOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

// --- Auth ------------------------------------------------------------------
const authEnabled = Boolean(APP_USER && APP_PASSWORD);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function basicAuth(req, res, next) {
  if (!authEnabled) return next(); // open when credentials aren't configured
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Tracking Gantt", charset="UTF-8"');
  res.status(401).send('Authentication required');
}

// --- HTTP ------------------------------------------------------------------
const app = express();
app.use(basicAuth); // applies to ALL routes, including /api and static assets
app.use(express.json({ limit: '8mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/state', async (_req, res) => {
  try {
    res.json(await readState());
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'read_failed' });
  }
});

app.put('/api/state', async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.projects)) {
    return res.status(400).json({ error: 'invalid_state' });
  }
  try {
    await writeState({
      projects: body.projects,
      activeProjectId: typeof body.activeProjectId === 'string' ? body.activeProjectId : null,
    });
    res.json(await readState());
  } catch (err) {
    console.error('PUT /api/state failed', err);
    res.status(500).json({ error: 'write_failed' });
  }
});

// Serve the built frontend from the same origin (single Railway service).
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(join(DIST, 'index.html'));
  });
}

async function main() {
  await initSchema();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gantt backend listening on http://0.0.0.0:${PORT}`);
    if (!authEnabled) {
      console.warn('WARNING: APP_USER/APP_PASSWORD not set — the app is publicly accessible without auth.');
    }
  });
}

main().catch((err) => {
  console.error('Startup failed', err);
  process.exit(1);
});
