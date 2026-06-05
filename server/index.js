// Single Railway service: serves the built frontend (/dist) AND the REST API on
// one port, backed by managed Postgres (the whole AppState is mirrored to two
// tables). Auth-gated with HTTP basic auth when credentials are configured.
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertRows, nowISO } from './rows.js';
import { adoConfigured, runSync, fetchWorkItemSnapshots } from './adoSync.js';
import { computeWeeklyRates } from './burndown.js';
import { createLlmProvider } from './llm.js';
import mammoth from 'mammoth';

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
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      project_id TEXT,
      title TEXT,
      filename TEXT,
      content_type TEXT,
      occurred_at TIMESTAMPTZ,
      data JSONB,
      raw_text TEXT,
      match_method TEXT,
      confidence REAL,
      evidence TEXT,
      summary TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ
    );
    -- Migrate older transcripts tables to the current shape (idempotent).
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS source_id TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS filename TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS content_type TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS raw_text TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS match_method TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS confidence REAL;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS evidence TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS summary TEXT;
    ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    -- Dedupe key: UNIQUE on source_id (Postgres treats NULLs as distinct).
    CREATE UNIQUE INDEX IF NOT EXISTS transcripts_source_id_key ON transcripts(source_id);
  `);
}

function strOrNull(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Collapse blank lines and trim. */
function cleanText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => l.trim() !== '' || (i > 0 && arr[i - 1].trim() !== ''))
    .join('\n')
    .trim();
}

/**
 * Parse WebVTT into plain text: drop the WEBVTT header, NOTE blocks, cue-number
 * lines and timestamp lines; turn <v Speaker>text</v> into "Speaker: text" and
 * strip any other tags; collapse blanks.
 */
function parseVtt(input) {
  const out = [];
  for (const raw of String(input || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^NOTE\b/.test(line)) continue;
    if (line.includes('-->')) continue; // timestamp cue
    if (/^\d+$/.test(line)) continue; // cue number
    line = line.replace(/<v\s+([^>]*)>([\s\S]*?)<\/v>/g, (_, sp, txt) => `${sp.trim()}: ${txt}`);
    line = line.replace(/<v\s+([^>]*)>/g, (_, sp) => `${sp.trim()}: `);
    line = line.replace(/<\/?[^>]+>/g, ''); // strip remaining tags
    line = line
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (line) out.push(line);
  }
  return out.join('\n').trim();
}

/** Base64-decode the content and return cleaned plain text (VTT/docx aware). */
async function extractRawText({ filename, contentType, contentBase64 }) {
  if (typeof contentBase64 !== 'string' || !contentBase64) return null;
  let buf;
  try {
    buf = Buffer.from(contentBase64, 'base64');
  } catch {
    return null;
  }
  const name = String(filename || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const isVtt = name.endsWith('.vtt') || ct.includes('vtt');
  const isDocx =
    name.endsWith('.docx') || ct.includes('wordprocessingml') || ct.includes('officedocument');
  if (isVtt) return parseVtt(buf.toString('utf8'));
  if (isDocx) {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      return cleanText(result.value);
    } catch (err) {
      console.error('docx extract failed', err.message);
      return null;
    }
  }
  return cleanText(buf.toString('utf8'));
}

/**
 * Deterministic tag match: a project matches if its name or any alias appears in
 * the lowercased text. Returns the project only when EXACTLY one matches.
 */
function matchProject(projects, text) {
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return null;
  const matched = [];
  for (const p of projects) {
    const terms = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])]
      .map((t) => String(t || '').trim().toLowerCase())
      .filter(Boolean);
    const hit = terms.find((t) => hay.includes(t));
    if (hit) matched.push({ id: p.id, term: hit });
  }
  return matched.length === 1 ? { projectId: matched[0].id, evidence: `matched "${matched[0].term}"` } : null;
}

/**
 * Persist one transcript payload from the Power Automate flow, deduped by
 * sourceId. Maps fields, decodes/cleans content into raw_text, runs the
 * deterministic tag match, and upserts on source_id. Returns the stored id.
 */
async function insertTranscript(payload, projects) {
  const sourceId = strOrNull(payload.sourceId);
  const title = strOrNull(payload.meetingTitle);
  const filename = strOrNull(payload.filename);
  const contentType = strOrNull(payload.contentType);
  const occRaw = strOrNull(payload.meetingDate);
  const occurredAt = occRaw && !Number.isNaN(Date.parse(occRaw)) ? occRaw : null;
  const rawText = await extractRawText(payload);

  const m = matchProject(projects, `${title || ''} ${filename || ''}`);
  const projectId = m ? m.projectId : null;
  const matchMethod = m ? 'tag' : null;
  const status = m ? 'categorized' : 'pending';
  const evidence = m ? m.evidence : null;

  const id = 't' + crypto.randomBytes(8).toString('hex');
  const result = await pool.query(
    `INSERT INTO transcripts
       (id, source_id, project_id, title, filename, content_type, occurred_at, data, raw_text,
        match_method, confidence, evidence, summary, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (source_id) DO UPDATE SET
       title = EXCLUDED.title,
       filename = EXCLUDED.filename,
       content_type = EXCLUDED.content_type,
       occurred_at = EXCLUDED.occurred_at,
       data = EXCLUDED.data,
       raw_text = EXCLUDED.raw_text,
       project_id = EXCLUDED.project_id,
       match_method = EXCLUDED.match_method,
       evidence = EXCLUDED.evidence,
       status = EXCLUDED.status
     RETURNING id`,
    [id, sourceId, projectId, title, filename, contentType, occurredAt, payload, rawText,
      matchMethod, null, evidence, null, status, nowISO()],
  );
  return result.rows[0].id;
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

/**
 * Upsert workstream rows on a single project (the manual ADO ingest path). Reads
 * the project's JSONB, merges rows via the shared helper, and writes it back in
 * one transaction — the same Postgres store as every other write. Never deletes
 * rows absent from the payload (removeStale: false). Returns a summary, or null
 * if the project does not exist.
 */
async function upsertProjectRows(projectId, incoming) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query('SELECT data FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (sel.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const project = sel.rows[0].data;
    const sprintCount = Number(project?.sprints?.sprintCount) || 0;
    const result = upsertRows(project.rows, incoming, { sprintCount, removeStale: false });
    project.rows = result.rows;
    const updatedAt = nowISO();
    project.updatedAt = updatedAt;
    await client.query('UPDATE projects SET data = $1, name = $2, updated_at = $3 WHERE id = $4', [
      project,
      typeof project.name === 'string' ? project.name : '',
      updatedAt,
      projectId,
    ]);
    await client.query('COMMIT');
    return { updated: result.updated, added: result.added, skipped: result.skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Auth ------------------------------------------------------------------
const authEnabled = Boolean(APP_USER && APP_PASSWORD);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// These routes are machine-to-machine and carry their own service-token check,
// so they bypass the human basic-auth gate.
const INGEST_PATH = /^\/api\/projects\/[^/]+\/rows$/;
function isServiceRoute(req) {
  return (
    (req.method === 'PUT' && INGEST_PATH.test(req.path)) ||
    (req.method === 'POST' &&
      (req.path === '/api/sync' || req.path === '/api/llm/ping' || req.path === '/api/transcripts'))
  );
}

function basicAuth(req, res, next) {
  if (isServiceRoute(req)) return next();
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

// Service-token gate for the ADO ingest route. Fails closed: if the expected
// credentials aren't configured in the environment, the route is rejected.
const { CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = process.env;
const ingestConfigured = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET);

function serviceTokenAuth(req, res, next) {
  if (!ingestConfigured) return res.status(403).json({ error: 'ingest_unconfigured' });
  const id = req.headers['cf-access-client-id'];
  const secret = req.headers['cf-access-client-secret'];
  if (!id || !secret) return res.status(403).json({ error: 'forbidden' });
  if (!safeEqual(id, CF_ACCESS_CLIENT_ID) || !safeEqual(secret, CF_ACCESS_CLIENT_SECRET)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
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

// ADO ingest: Power Automate pushes Azure DevOps rows into one project's
// workstreams. Service-token auth only; never deletes rows absent from payload.
app.put('/api/projects/:id/rows', serviceTokenAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'expected_array' });
  }
  try {
    const summary = await upsertProjectRows(req.params.id, req.body);
    if (summary === null) return res.status(404).json({ error: 'project_not_found' });
    res.json(summary);
  } catch (err) {
    console.error('PUT /api/projects/:id/rows failed', err);
    res.status(500).json({ error: 'write_failed' });
  }
});

// App-owned ADO sync. In-memory lock skips overlapping runs (cron + manual).
let syncing = false;
async function runSyncLocked(trigger) {
  if (syncing) {
    console.warn(`ADO sync (${trigger}) skipped: a sync is already running.`);
    return { skipped: true };
  }
  syncing = true;
  try {
    const summaries = await runSync({ readState, writeState });
    return { summaries };
  } finally {
    syncing = false;
  }
}

// Manual trigger for machines (e.g. a webhook) — service-token check.
app.post('/api/sync', serviceTokenAuth, async (_req, res) => {
  if (!adoConfigured()) return res.status(503).json({ error: 'ado_not_configured' });
  try {
    const result = await runSyncLocked('manual');
    if (result.skipped) return res.status(409).json({ error: 'sync_in_progress' });
    res.json(result.summaries);
  } catch (err) {
    console.error('POST /api/sync failed', err);
    res.status(500).json({ error: 'sync_failed' });
  }
});

// Manual trigger for the UI ("Sync from ADO" button) — gated by the normal human
// auth (basic auth / Cloudflare Access), not the service token. Lets a signed-in
// user re-pull from ADO on demand, e.g. to restore a project they deleted.
app.post('/api/sync/run', async (_req, res) => {
  if (!adoConfigured()) return res.status(503).json({ error: 'ado_not_configured' });
  try {
    const result = await runSyncLocked('manual-ui');
    if (result.skipped) return res.status(409).json({ error: 'sync_in_progress' });
    res.json(result.summaries);
  } catch (err) {
    console.error('POST /api/sync/run failed', err);
    res.status(500).json({ error: 'sync_failed' });
  }
});

// Verify the configured LLM provider — same service-token check as /api/sync.
// Flip LLM_PROVIDER and hit this to confirm each backend works.
app.post('/api/llm/ping', serviceTokenAuth, async (_req, res) => {
  try {
    const provider = createLlmProvider();
    const output = await provider.generate({
      system: 'You are a test.',
      user: 'Reply with the single word: OK',
    });
    res.json({ provider: provider.name, output });
  } catch (err) {
    console.error('POST /api/llm/ping failed', err);
    res.status(502).json({ error: 'llm_failed', message: err.message, upstreamStatus: err.status });
  }
});

// Transcript ingest (Power Automate). Service-token auth, same as /api/sync.
// Accepts a single transcript object or an array; deduped/upserted by sourceId,
// content decoded+cleaned into raw_text, deterministic tag match per ingest.
app.post('/api/transcripts', serviceTokenAuth, async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'expected_object_or_array' });
  }
  try {
    const { projects } = await readState(); // for the deterministic tag match
    const ids = [];
    for (const item of items) {
      if (item && typeof item === 'object') ids.push(await insertTranscript(item, projects));
    }
    res.status(201).json({ stored: ids.length, ids });
  } catch (err) {
    console.error('POST /api/transcripts failed', err);
    res.status(500).json({ error: 'store_failed' });
  }
});

// Total project burndown from ADO WorkItemSnapshot — human-gated read. Cached ~1h.
const burndownCache = new Map(); // projectId -> { expires, payload }
const BURNDOWN_TTL = 60 * 60 * 1000;

function sprintAxisRange(project) {
  const sd = project?.sprints?.sprintDates;
  if (!Array.isArray(sd) || sd.length === 0) return { start: null, plannedEnd: null };
  const starts = sd.map((s) => s.start).filter(Boolean).sort();
  const ends = sd.map((s) => s.end).filter(Boolean).sort();
  return { start: starts[0] || null, plannedEnd: ends[ends.length - 1] || null };
}

app.get('/api/projects/:id/burndown', async (req, res) => {
  const id = req.params.id;
  try {
    const cached = burndownCache.get(id);
    if (cached && cached.expires > Date.now()) return res.json(cached.payload);

    const { projects } = await readState();
    const project = projects.find((p) => p.id === id);
    if (!project) return res.status(404).json({ error: 'project_not_found' });

    const today = nowISO().slice(0, 10);
    const { start: axisStart, plannedEnd } = sprintAxisRange(project);
    const emptyPayload = {
      start: axisStart,
      end: today,
      plannedEnd,
      initialRemaining: 0,
      points: [],
      computedBestRate: null,
      computedWorstRate: null,
      weeklyRates: [],
      weeklySeries: [],
    };

    if (!adoConfigured() || !project.adoProjectName) {
      return res.json(emptyPayload); // graceful: no ADO binding / not configured
    }

    let rows = [];
    try {
      rows = await fetchWorkItemSnapshots(project.adoProjectName, axisStart, today);
    } catch (err) {
      console.error('burndown snapshot query failed', err.message);
      return res.json(emptyPayload);
    }

    // Full daily series (used for rate computation before any thinning).
    const series = rows
      .map((r) => {
        const date = String(r.DateValue || '').slice(0, 10);
        const remaining = Number(r.TotalRemaining) || 0;
        const completed = Number(r.TotalCompleted) || 0;
        return { date, remaining, completed, scope: remaining + completed };
      })
      .filter((p) => p.date)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const rates = computeWeeklyRates(series);
    console.log(
      `burndown ${project.adoProjectName}: best=${rates.computedBestRate} worst=${rates.computedWorstRate} ` +
        `weeks=${rates.weeklySeries.length} sampled=${rates.weeklyRates.length}`,
    );
    for (const w of rates.weeklySeries) {
      console.log(
        `  ${w.weekStart}  remaining=${w.remaining}  completed=${w.completed}  throughput=${w.throughput ?? '-'}  ${w.includedInSample ? 'IN' : 'out'}`,
      );
    }

    // Thin to ~weekly for the chart when the range is long, keeping the last point.
    let points = series;
    if (series.length > 120) {
      const thinned = series.filter((_, i) => i % 7 === 0);
      const last = series[series.length - 1];
      if (thinned[thinned.length - 1] !== last) thinned.push(last);
      points = thinned;
    }

    const payload = {
      start: axisStart || (series[0]?.date ?? today),
      end: today,
      plannedEnd,
      initialRemaining: series[0]?.remaining ?? 0,
      points,
      ...rates,
    };
    burndownCache.set(id, { expires: Date.now() + BURNDOWN_TTL, payload });
    res.json(payload);
  } catch (err) {
    console.error('GET /api/projects/:id/burndown failed', err);
    res.status(500).json({ error: 'burndown_failed' });
  }
});

// List recent transcripts (metadata only) — human-gated, for verifying ingestion.
app.get('/api/transcripts', async (_req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, source_id, project_id, title, occurred_at, match_method, status, created_at FROM transcripts ORDER BY created_at DESC LIMIT 200',
    );
    res.json({ transcripts: r.rows });
  } catch (err) {
    console.error('GET /api/transcripts failed', err);
    res.status(500).json({ error: 'read_failed' });
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

function startAdoScheduler() {
  // Fail closed: with no PAT/org, skip syncing entirely (never crash).
  if (!adoConfigured()) {
    console.warn('WARNING: ADO_PAT/ADO_ORG not set — app-owned ADO sync is disabled.');
    return;
  }
  let expr = process.env.ADO_SYNC_CRON || '0 * * * *';
  if (!cron.validate(expr)) {
    console.warn(`ADO_SYNC_CRON "${expr}" is invalid; falling back to "0 * * * *" (hourly).`);
    expr = '0 * * * *';
  }
  cron.schedule(expr, () => {
    runSyncLocked('cron').catch((err) => console.error('ADO sync (cron) failed:', err.message));
  });
  console.log(`ADO sync scheduled: "${expr}". Projects: ${process.env.ADO_PROJECTS || '(all)'}`);
  // Run one sync shortly after boot.
  setTimeout(() => {
    runSyncLocked('boot').catch((err) => console.error('ADO sync (boot) failed:', err.message));
  }, 5000);
}

async function main() {
  await initSchema();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gantt backend listening on http://0.0.0.0:${PORT}`);
    if (!authEnabled) {
      console.warn('WARNING: APP_USER/APP_PASSWORD not set — the app is publicly accessible without auth.');
    }
    if (!ingestConfigured) {
      console.warn(
        'WARNING: CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET not set — ADO ingest + manual sync trigger (PUT /api/projects/:id/rows, POST /api/sync) are disabled (fail closed).',
      );
    }
    startAdoScheduler();
  });
}

main().catch((err) => {
  console.error('Startup failed', err);
  process.exit(1);
});
