// Радар ИИ-видимости — HTTP server (zero external deps).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import * as store from './db.mjs';
import * as engine from './analysis.mjs';
import { generateInsights, aiConfig } from './openai.mjs';
import { config as keysoConfig } from './keyso.mjs';
import { buildDocx } from './docx.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 5173);
const BASE = process.env.KEYSO_BASE || 'msk';

// ---- In-memory job registry for streaming analysis progress ----
const jobs = new Map(); // jobId -> { logs:[], subs:Set<res>, done, error, projectId }

function jobEmit(job, message) {
  const line = { t: Date.now(), message };
  const id = job.logs.push(line) - 1;
  for (const res of job.subs) sendSse(res, 'log', line, id);
}
function jobFinish(job, patch) {
  Object.assign(job, patch, { done: true });
  for (const res of job.subs) {
    sendSse(res, 'done', { projectId: job.projectId, error: job.error || null });
    res.end();
  }
  job.subs.clear();
}
function sendSse(res, event, data, id) {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE-поток отдаётся короткими сегментами: сервер закрывает соединение каждые
// SSE_SEGMENT_MS, браузерный EventSource сам переподключается с Last-Event-ID
// и получает только новые строки. Так поток проходит через PHP-прокси хостинга,
// не упираясь в fastcgi_read_timeout и не держа PHP-FPM воркер минутами.
const SSE_SEGMENT_MS = 20_000;

async function runAnalysis(job, name, domains) {
  try {
    jobEmit(job, `Старт анализа: ${domains.length} сайт(ов), база ${BASE}`);
    const snaps = [];
    for (const { domain, role } of domains) {
      jobEmit(job, `=== ${domain} (${role === 'client' ? 'клиент' : 'конкурент'}) ===`);
      const snap = await engine.collectDomain(domain, role, (m) => jobEmit(job, m));
      jobEmit(
        job,
        `[${domain}] готово: ${snap.ai_cited_count} ИИ-цитирований, охват ${snap.ai_reach.toLocaleString('ru')}`
      );
      snaps.push(snap);
    }
    jobEmit(job, 'Сохраняем в память…');
    const projectId = store.createProject(name, BASE);
    for (const snap of snaps) store.saveSnapshot(projectId, snap);
    jobEmit(job, `Проект #${projectId} сохранён.`);
    jobFinish(job, { projectId });
  } catch (e) {
    jobEmit(job, `ОШИБКА: ${e.message}`);
    jobFinish(job, { error: e.message });
  }
}

// ---- Request helpers ----
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 30e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, safe);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ---- Router ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/config') {
      return json(res, 200, {
        base: BASE,
        keyso: keysoConfig.TOKEN_SET,
        openai: aiConfig.KEY_SET,
        openai_model: aiConfig.MODEL,
        ctr: engine.constants,
      });
    }

    if (p === '/api/projects' && req.method === 'GET') {
      return json(res, 200, store.listProjects());
    }

    if (p === '/api/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || `Анализ ${new Date().toLocaleString('ru')}`).slice(0, 200);
      const raw = Array.isArray(body.domains) ? body.domains : [];
      const seen = new Set();
      const domains = [];
      for (const d of raw) {
        const domain = engine.normalizeDomain(d.domain);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        domains.push({ domain, role: d.role === 'client' ? 'client' : 'competitor' });
      }
      if (!domains.length) return json(res, 400, { error: 'Нет валидных доменов' });
      if (!domains.some((d) => d.role === 'client'))
        return json(res, 400, { error: 'Не выбран сайт клиента' });
      const jobId = randomUUID();
      const job = { logs: [], subs: new Set(), done: false, error: null, projectId: null };
      jobs.set(jobId, job);
      runAnalysis(job, name, domains);
      return json(res, 202, { jobId });
    }

    const streamMatch = p.match(/^\/api\/analyze\/stream\/([\w-]+)$/);
    if (streamMatch) {
      const job = jobs.get(streamMatch[1]);
      if (!job) return json(res, 404, { error: 'job not found' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      const lastId = Number.parseInt(req.headers['last-event-id'], 10);
      const from = Number.isInteger(lastId) && lastId >= 0 ? lastId + 1 : 0;
      for (let i = from; i < job.logs.length; i++) sendSse(res, 'log', job.logs[i], i);
      if (job.done) {
        sendSse(res, 'done', { projectId: job.projectId, error: job.error || null });
        return res.end();
      }
      job.subs.add(res);
      const segment = setTimeout(() => {
        job.subs.delete(res);
        res.end();
      }, SSE_SEGMENT_MS);
      res.on('close', () => {
        clearTimeout(segment);
        job.subs.delete(res);
      });
      return;
    }

    const projMatch = p.match(/^\/api\/project\/(\d+)$/);
    if (projMatch) {
      const id = Number(projMatch[1]);
      if (req.method === 'DELETE') {
        store.deleteProject(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 200);
        if (!name) return json(res, 400, { error: 'Пустое название' });
        if (!store.getProject(id, { withQueries: false }))
          return json(res, 404, { error: 'not found' });
        store.renameProject(id, name);
        return json(res, 200, { ok: true, name });
      }
      const project = store.getProject(id);
      if (!project) return json(res, 404, { error: 'not found' });
      const comparison = engine.compareProject(project);
      return json(res, 200, {
        id: project.id,
        name: project.name,
        base: project.base,
        created_at: project.created_at,
        insights: project.insights,
        comparison,
        snapshots: project.snapshots.map((s) => ({
          domain: s.domain,
          role: s.role,
          ai_cited_count: s.ai_cited_count,
          ai_reach: s.ai_reach,
          it1: s.it1,
          it3: s.it3,
          it5: s.it5,
          it10: s.it10,
          it50: s.it50,
          organic_vis: s.organic_vis,
          metrics: s.metrics,
        })),
      });
    }

    const docxMatch = p.match(/^\/api\/project\/(\d+)\/docx$/);
    if (docxMatch && (req.method === 'GET' || req.method === 'POST')) {
      const id = Number(docxMatch[1]);
      const project = store.getProject(id);
      if (!project) return json(res, 404, { error: 'not found' });
      let charts = null;
      if (req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        charts = body && body.charts ? body.charts : null;
      }
      const comparison = engine.compareProject(project);
      const buffer = buildDocx(project, comparison, project.insights, charts);
      const asciiName = `ai-radar-${id}.docx`;
      const utfName = encodeURIComponent(`Радар-ИИ-${project.name}.docx`);
      res.writeHead(200, {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utfName}`,
        'Content-Length': buffer.length,
      });
      return res.end(buffer);
    }

    const insightsMatch = p.match(/^\/api\/project\/(\d+)\/insights$/);
    if (insightsMatch && req.method === 'POST') {
      const id = Number(insightsMatch[1]);
      const project = store.getProject(id);
      if (!project) return json(res, 404, { error: 'not found' });
      const cmp = engine.compareProject(project);
      if (!cmp.client) return json(res, 400, { error: 'Нет сайта клиента' });
      const payload = {
        base: project.base,
        client: cmp.client,
        competitors: cmp.competitors,
        leaderboard: cmp.leaderboard,
        headToHead: cmp.headToHead,
        forecast: cmp.forecast,
        gapTop: cmp.gap.slice(0, 30),
        strengthsTop: cmp.strengths.slice(0, 20),
      };
      try {
        const insights = await generateInsights(payload);
        store.saveInsights(id, insights);
        return json(res, 200, insights);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`\n  Радар ИИ-видимости → http://localhost:${PORT}`);
  console.log(`  База Keys.so: ${BASE} | Keys.so токен: ${keysoConfig.TOKEN_SET ? 'ok' : 'НЕТ'} | OpenAI: ${aiConfig.KEY_SET ? aiConfig.MODEL : 'НЕТ'}\n`);
});
