// Keys.so API client — ИИ-выдача (Яндекс Алиса)
// Docs: https://apidoc.keys.so/  Auth header: X-Keyso-TOKEN
const BASE_URL = 'https://api.keys.so';
const TOKEN = process.env.KEYS_SO_TOKEN;
const BASE = process.env.KEYSO_BASE || 'msk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keys.so sometimes embeds raw C0 control chars inside string values, which is
// invalid JSON. Replace them with a space and retry.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F]', 'g');
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(CONTROL_CHARS, ' '));
  }
}

// Keys.so rate-limits by requests/minute. Serialize requests with a minimum
// spacing so a multi-domain analysis does not trip the 429 limiter.
const MIN_INTERVAL = 350; // ms between requests
let chain = Promise.resolve();
let lastAt = 0;
function throttle() {
  chain = chain.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastAt));
    if (wait) await sleep(wait);
    lastAt = Date.now();
  });
  return chain;
}

async function rawGet(path, params = {}, { onRateLimit } = {}) {
  const url = new URL(BASE_URL + path);
  url.searchParams.set('base', BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  // Retry transient failures (429 rate limit, 5xx) with backoff.
  const backoffs = [4000, 9000, 16000, 25000, 40000];
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res, text;
    try {
      res = await fetch(url, { headers: { 'X-Keyso-TOKEN': TOKEN } });
      text = await res.text();
    } catch (e) {
      if (attempt >= backoffs.length) throw e;
      await sleep(backoffs[attempt]);
      continue;
    }
    let json;
    try {
      json = safeParse(text);
    } catch (e) {
      throw new Error(`Keys.so parse error ${path}: ${e.message} :: ${text.slice(0, 200)}`);
    }
    const rateLimited =
      res.status === 429 ||
      res.status >= 500 ||
      (json && typeof json === 'object' && !Array.isArray(json) && (json.code === 429 || json.code >= 500));
    if (rateLimited && attempt < backoffs.length) {
      if (onRateLimit) onRateLimit(attempt + 1);
      await sleep(backoffs[attempt]);
      continue;
    }
    return { status: res.status, json };
  }
}

// GET that transparently handles the "202 — отчёт строится" pattern by polling.
async function getWithPoll(path, params = {}, { tries = 18, delay = 6000, onWait } = {}) {
  for (let i = 0; i < tries; i++) {
    const { json } = await rawGet(path, params, {
      onRateLimit: (a) => onWait && onWait(i + 1, `лимит запросов, пауза (попытка ${a})`),
    });
    const building =
      json && typeof json === 'object' && !Array.isArray(json) && json.code === 202;
    if (!building) return json;
    if (onWait) onWait(i + 1, json.message || 'building');
    await sleep(delay);
  }
  throw new Error(`Keys.so timeout building report: ${path}`);
}

// AI report readiness. ai_state: 10 = ready
export async function aiState(domain) {
  const { json } = await rawGet('/report/simple/ai-answers/state', { domain });
  return json; // { ai_state, domain, base }
}

// Queries where the domain is CITED as a source in the Alice AI answer.
// Returns [{ query_text, query_answer }]. This is the core "ИИ-видимость" metric.
export async function aiAnswers(domain, limit = 2000, onWait) {
  const json = await getWithPoll(
    '/report/simple/domain_dashboard/ai-answers',
    { domain, limit },
    { onWait }
  );
  return Array.isArray(json) ? json : [];
}

// Competitor landscape in AI answers. Each row carries queries_in_ai_answers,
// vis (organic visibility), it5/it10/it50, cnt (shared AI queries).
export async function aiConcurents(domain, perPage = 100, onWait) {
  const json = await getWithPoll(
    '/report/simple/organic/ai-concurents',
    { domain, per_page: perPage, sort: 'queries_in_ai_answers|desc' },
    { onWait }
  );
  return json && Array.isArray(json.data) ? json.data : [];
}

// General organic dashboard — it1/it3/it5/it10/it50, overall keys, competitors.
export async function domainDashboard(domain, onWait) {
  const json = await getWithPoll('/report/simple/domain_dashboard', { domain }, { onWait });
  return json;
}

// Lightweight organic keywords (no AI-answer HTML) — word + ws + wsk + pos.
// Used to build a {query -> частотность} map to enrich cited queries. Bounded:
// cited AI queries are long-tail, so we cover the higher-frequency ones (the
// priority queries) and leave deep long-tail without an exact frequency.
export async function organicKeywords(domain, pages = 6, perPage = 500, onWait) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const json = await getWithPoll(
      '/report/simple/organic/keywords',
      { domain, per_page: perPage, current_page: p },
      { onWait }
    );
    const rows = json && Array.isArray(json.data) ? json.data : [];
    out.push(...rows);
    if (rows.length < perPage) break;
  }
  return out; // [{ word, ws, wsk, superwsk, pos, ... }]
}

export const config = { BASE, TOKEN_SET: Boolean(TOKEN) };
