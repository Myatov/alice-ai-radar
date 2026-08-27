// Persistent storage ("память") for projects, domains, snapshots and AI queries.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'analytics.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT 'msk',
  created_at TEXT NOT NULL,
  insights_json TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'client' | 'competitor'
  taken_at TEXT NOT NULL,
  ai_cited_count INTEGER DEFAULT 0, -- queries where domain is cited in Alice answers
  organic_vis REAL DEFAULT 0,
  it1 INTEGER DEFAULT 0,
  it3 INTEGER DEFAULT 0,
  it5 INTEGER DEFAULT 0,
  it10 INTEGER DEFAULT 0,
  it50 INTEGER DEFAULT 0,
  ai_reach INTEGER DEFAULT 0,       -- sum of частотность over cited queries (matched)
  metrics_json TEXT,                -- extra metrics & competitor rows
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  query_text TEXT NOT NULL,
  ws INTEGER DEFAULT 0,             -- broad-match Wordstat frequency (reference)
  wsk INTEGER DEFAULT 0,            -- phrase-match ("!") frequency — forecast-grade
  answer TEXT,                      -- Alice AI answer text
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snap_project ON snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_q_snap ON ai_queries(snapshot_id);
`);

const nowIso = () => new Date().toISOString();

export function createProject(name, base) {
  const info = db
    .prepare('INSERT INTO projects (name, base, created_at) VALUES (?, ?, ?)')
    .run(name, base, nowIso());
  return Number(info.lastInsertRowid);
}

export function saveSnapshot(projectId, snap) {
  const info = db
    .prepare(
      `INSERT INTO snapshots
       (project_id, domain, role, taken_at, ai_cited_count, organic_vis, it1, it3, it5, it10, it50, ai_reach, metrics_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      projectId,
      snap.domain,
      snap.role,
      nowIso(),
      snap.ai_cited_count | 0,
      snap.organic_vis || 0,
      snap.it1 | 0,
      snap.it3 | 0,
      snap.it5 | 0,
      snap.it10 | 0,
      snap.it50 | 0,
      snap.ai_reach | 0,
      JSON.stringify(snap.metrics || {})
    );
  const snapId = Number(info.lastInsertRowid);
  const insertQ = db.prepare(
    'INSERT INTO ai_queries (snapshot_id, query_text, ws, wsk, answer) VALUES (?,?,?,?,?)'
  );
  const rows = snap.queries || [];
  db.exec('BEGIN');
  try {
    for (const r of rows) insertQ.run(snapId, r.query_text, r.ws | 0, r.wsk | 0, r.answer || '');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return snapId;
}

export function renameProject(projectId, name) {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, projectId);
}

export function saveInsights(projectId, insights) {
  db.prepare('UPDATE projects SET insights_json = ? WHERE id = ?').run(
    JSON.stringify(insights),
    projectId
  );
}

export function listProjects() {
  const rows = db
    .prepare('SELECT id, name, base, created_at FROM projects ORDER BY id DESC')
    .all();
  const cnt = db.prepare('SELECT COUNT(*) c FROM snapshots WHERE project_id = ?');
  return rows.map((p) => ({ ...p, domains: cnt.get(p.id).c }));
}

export function getProject(projectId, { withQueries = true } = {}) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  const snaps = db
    .prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY id')
    .all(projectId);
  const qStmt = db.prepare(
    'SELECT query_text, ws, wsk, answer FROM ai_queries WHERE snapshot_id = ? ORDER BY ws DESC'
  );
  const snapshots = snaps.map((s) => ({
    ...s,
    metrics: safe(s.metrics_json),
    queries: withQueries ? qStmt.all(s.id) : [],
  }));
  return {
    id: project.id,
    name: project.name,
    base: project.base,
    created_at: project.created_at,
    insights: safe(project.insights_json),
    snapshots,
  };
}

export function deleteProject(projectId) {
  const snaps = db.prepare('SELECT id FROM snapshots WHERE project_id = ?').all(projectId);
  const delQ = db.prepare('DELETE FROM ai_queries WHERE snapshot_id = ?');
  for (const s of snaps) delQ.run(s.id);
  db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

function safe(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
