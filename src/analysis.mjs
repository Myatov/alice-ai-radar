// Analysis engine: collect per-domain AI visibility from Keys.so, then compute
// cross-domain comparison — leaderboard, semantic gap, strengths and forecast.
import * as keyso from './keyso.mjs';

// Forecast model. Cited AI queries are predominantly long-tail informational
// queries, so we model potential by QUERY COUNT with a conservative average of
// monthly visits per query, rather than by summing broad Wordstat frequency
// (which a few navigational/brand terms would distort). Assumptions are shown
// in the UI and are easy to tune.
const VISITS_PER_AI_CITED = 15; // avg monthly visits from being cited in the Alice AI block
const VISITS_PER_TOP3 = 50; // avg monthly visits when also ranking top-3 organic

export function normalizeDomain(input) {
  if (!input) return '';
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d;
}

const qkey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Collect everything we need for one domain. `emit` streams progress messages.
export async function collectDomain(domain, role, emit = () => {}) {
  emit(`[${domain}] проверка готовности ИИ-отчёта…`);
  const state = await keyso.aiState(domain);
  const ready = state && state.ai_state === 10;

  emit(`[${domain}] снимаем цитирования в ИИ-выдаче Алисы…`);
  const cited = await keyso.aiAnswers(domain, 2000, (n, m) =>
    emit(`[${domain}] ИИ-ответы строятся (${n}): ${m}`)
  );

  emit(`[${domain}] тянем частотности (Wordstat)…`);
  let organic = [];
  try {
    organic = await keyso.organicKeywords(domain, 6, 500, (n, m) =>
      emit(`[${domain}] семантика строится (${n}): ${m}`)
    );
  } catch (e) {
    emit(`[${domain}] семантика недоступна: ${e.message}`);
  }

  emit(`[${domain}] тянем общий органический дашборд…`);
  let dashboard = null;
  try {
    dashboard = await keyso.domainDashboard(domain, (n, m) =>
      emit(`[${domain}] дашборд строится (${n}): ${m}`)
    );
  } catch (e) {
    emit(`[${domain}] дашборд недоступен: ${e.message}`);
  }

  emit(`[${domain}] тянем ИИ-конкурентов…`);
  let competitors = [];
  try {
    competitors = await keyso.aiConcurents(domain, 100, (n, m) =>
      emit(`[${domain}] ИИ-конкуренты строятся (${n}): ${m}`)
    );
  } catch (e) {
    emit(`[${domain}] ИИ-конкуренты недоступны: ${e.message}`);
  }

  // Build query -> частотность map from organic AI-answer rows. We keep the
  // phrase-match frequency (wsk, "!запрос") as the realistic, forecast-grade
  // number and the broad-match (ws) only as reference.
  const wsMap = new Map();
  for (const r of organic) {
    const k = qkey(r.word);
    if (!k) continue;
    const wsk = r.wsk | 0;
    const prev = wsMap.get(k);
    if (!prev || wsk > prev.wsk) wsMap.set(k, { ws: r.ws | 0, wsk });
  }

  // Enrich cited queries with частотность where we can match by text.
  const queries = cited.map((c) => {
    const m = wsMap.get(qkey(c.query_text)) || { ws: 0, wsk: 0 };
    return {
      query_text: c.query_text,
      ws: m.ws,
      wsk: m.wsk,
      answer: c.query_answer || '',
    };
  });

  // Broad-match частотность (ws) is the conventional displayed Wordstat metric
  // and, with full-query matching, stays credible. wsk kept as reference.
  const aiReach = queries.reduce((s, q) => s + q.ws, 0);
  const matched = queries.filter((q) => q.ws > 0).length;

  const d = dashboard || {};
  const snap = {
    domain,
    role,
    ai_ready: ready,
    ai_cited_count: queries.length,
    organic_vis: 0,
    it1: d.it1 | 0,
    it3: d.it3 | 0,
    it5: d.it5 | 0,
    it10: d.it10 | 0,
    it50: d.it50 | 0,
    ai_reach: aiReach,
    queries,
    metrics: {
      ai_matched_freq: matched,
      organic_competitors: (d.concs || []).slice(0, 12).map((c) => ({
        name: c.name,
        vis: c.vis,
        perc: c.perc,
      })),
      ai_competitors: competitors.slice(0, 30).map((c) => ({
        name: normalizeDomain(c.name),
        queries_in_ai_answers: c.queries_in_ai_answers | 0,
        vis: c.vis | 0,
        it5: c.it5 | 0,
        it10: c.it10 | 0,
        it50: c.it50 | 0,
        shared: c.cnt | 0,
      })),
      top_ws: (d.keys || [])
        .slice(0, 20)
        .map((k) => ({ word: k.word, ws: k.ws, pos: k.pos })),
    },
  };
  // Derive an organic visibility proxy from top-N counts if vis not present.
  snap.organic_vis = snap.it5 * 5 + snap.it10 * 2 + snap.it50;
  return snap;
}

// Per-query частотность is capped when aggregating "reach" so a single very
// broad query (e.g. a one-word category with millions of impressions) cannot
// dominate the metric and flatten every other domain on the chart.
const REACH_CAP = 10000;

// Cross-domain comparison from a stored project (snapshots + their queries).
export function compareProject(project) {
  const snaps = project.snapshots.map((s) => {
    const queries = s.queries || [];
    // Recompute a robust, outlier-resistant "ИИ-охват" from stored частотности.
    const reach = queries.reduce((sum, q) => sum + Math.min(q.ws || 0, REACH_CAP), 0);
    return {
      ...s,
      ai_reach: reach,
      metrics: s.metrics || {},
      querySet: new Map(queries.map((q) => [qkey(q.query_text), q])),
    };
  });

  const client = snaps.find((s) => s.role === 'client');
  const competitors = snaps.filter((s) => s.role === 'competitor');

  // Leaderboard by AI-cited count.
  const leaderboard = snaps
    .map((s) => ({
      domain: s.domain,
      role: s.role,
      ai_cited: s.ai_cited_count,
      ai_reach: s.ai_reach,
      it5: s.it5,
      it10: s.it10,
      it50: s.it50,
      organic_vis: s.organic_vis,
    }))
    .sort((a, b) => b.ai_cited - a.ai_cited);

  // Radar metrics — normalized 0..100 across the set.
  const radarAxes = [
    { key: 'ai_cited_count', label: 'ИИ-цитирования' },
    { key: 'ai_reach', label: 'ИИ-охват (частотность)' },
    { key: 'it5', label: 'ТОП-5 (органика)' },
    { key: 'it10', label: 'ТОП-10' },
    { key: 'it50', label: 'ТОП-50' },
  ];
  const radar = radarAxes.map((ax) => {
    const max = Math.max(1, ...snaps.map((s) => s[ax.key] || 0));
    return {
      axis: ax.label,
      values: snaps.map((s) => ({
        domain: s.domain,
        value: Math.round(((s[ax.key] || 0) / max) * 100),
      })),
    };
  });

  let gap = [];
  let strengths = [];
  let forecast = null;
  if (client) {
    // Union of competitor cited queries not present for the client = opportunity.
    const gapMap = new Map();
    for (const comp of competitors) {
      for (const [k, q] of comp.querySet) {
        if (client.querySet.has(k)) continue;
        const cur = gapMap.get(k) || {
          query_text: q.query_text,
          freq: q.ws,
          competitors: [],
        };
        cur.freq = Math.max(cur.freq, q.ws);
        cur.competitors.push(comp.domain);
        gapMap.set(k, cur);
      }
    }
    gap = [...gapMap.values()]
      .map((g) => ({ ...g, coverage: g.competitors.length }))
      .sort((a, b) => b.freq - a.freq || b.coverage - a.coverage);

    // Client strengths — cited where NO competitor is cited.
    const compUnion = new Set();
    for (const comp of competitors) for (const k of comp.querySet.keys()) compUnion.add(k);
    strengths = [...client.querySet.values()]
      .filter((q) => !compUnion.has(qkey(q.query_text)))
      .sort((a, b) => b.ws - a.ws)
      .map((q) => ({ query_text: q.query_text, freq: q.ws }));

    // Forecast — count-based model over the gap semantics.
    const gapQueries = gap.length;
    const knownFreq = gap.filter((g) => g.freq > 0).length;
    forecast = {
      current_ai_cited: client.ai_cited_count,
      current_ai_traffic: client.ai_cited_count * VISITS_PER_AI_CITED,
      gap_queries: gapQueries,
      gap_freq_known: knownFreq,
      potential_ai_traffic: gapQueries * VISITS_PER_AI_CITED,
      potential_ai_traffic_top3: gapQueries * VISITS_PER_TOP3,
      visits_per_ai_cited: VISITS_PER_AI_CITED,
      visits_per_top3: VISITS_PER_TOP3,
    };
  }

  // Head-to-head vs the strongest competitor (by AI-cited).
  const topCompetitor = [...competitors].sort((a, b) => b.ai_cited_count - a.ai_cited_count)[0];
  const headToHead =
    client && topCompetitor
      ? {
          competitor: topCompetitor.domain,
          client_ai_cited: client.ai_cited_count,
          competitor_ai_cited: topCompetitor.ai_cited_count,
          gap_ratio:
            client.ai_cited_count > 0
              ? +(topCompetitor.ai_cited_count / client.ai_cited_count).toFixed(2)
              : null,
        }
      : null;

  return {
    client: client ? client.domain : null,
    competitors: competitors.map((c) => c.domain),
    leaderboard,
    radar,
    radarDomains: snaps.map((s) => ({ domain: s.domain, role: s.role })),
    gap: gap.slice(0, 200),
    gap_total: gap.length,
    strengths: strengths.slice(0, 100),
    strengths_total: strengths.length,
    forecast,
    headToHead,
  };
}

export const constants = { VISITS_PER_AI_CITED, VISITS_PER_TOP3 };
