'use strict';

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const nf = new Intl.NumberFormat('ru-RU');
const fmt = (n) => nf.format(Math.round(n || 0));
const fmtShort = (n) => {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' млн';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + ' тыс';
  return String(Math.round(n));
};
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast hidden'), 3800);
}

// ---------- palette ----------
const CLIENT_COLOR = '#34d9a8';
const COMP_COLORS = ['#ff8a5c', '#6d8bff', '#9a6dff', '#ffcc57', '#ff5c7c', '#2bb4d9', '#c084fc', '#7dd87d'];
function domainColors(domains) {
  const map = {};
  let ci = 0;
  for (const d of domains) map[d.domain] = d.role === 'client' ? CLIENT_COLOR : COMP_COLORS[ci++ % COMP_COLORS.length];
  return map;
}

// ---------- state ----------
let parsed = []; // [{domain, role}]
let currentProject = null;
const charts = [];
function clearCharts() {
  while (charts.length) {
    try { charts.pop().destroy(); } catch {}
  }
}

// ---------- views ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}
$$('.nav-btn').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.disabled) return;
    showView(b.dataset.view);
  })
);

// ---------- setup: parse domains ----------
function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  if (!d) return '';
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  return d;
}
$('#parse-btn').addEventListener('click', parseDomains);
function parseDomains() {
  const lines = $('#domains-input').value.split(/[\n,;]+/).map(normalizeDomain).filter(Boolean);
  const seen = new Set();
  const next = [];
  for (const d of lines) {
    if (seen.has(d)) continue;
    seen.add(d);
    const existing = parsed.find((p) => p.domain === d);
    next.push({ domain: d, role: existing ? existing.role : 'competitor' });
  }
  parsed = next;
  if (parsed.length && !parsed.some((p) => p.role === 'client')) parsed[0].role = 'client';
  renderRoles();
}

function renderRoles() {
  const box = $('#roles-list');
  box.innerHTML = '';
  if (!parsed.length) {
    box.appendChild(el('div', 'empty', 'Сначала внесите и разберите сайты слева.'));
    $('#run-btn').disabled = true;
    return;
  }
  parsed.forEach((p, i) => {
    const row = el('div', 'role-row');
    row.innerHTML = `
      <span class="rr-domain">${esc(p.domain)}</span>
      <div class="role-seg">
        <button class="seg-btn ${p.role === 'client' ? 'client-on' : 'off'}" data-role="client">Клиент</button>
        <button class="seg-btn ${p.role === 'competitor' ? 'comp-on' : 'off'}" data-role="competitor">Конкурент</button>
      </div>
      <span class="rr-remove" title="Убрать">✕</span>`;
    $$('.seg-btn', row).forEach((btn) =>
      btn.addEventListener('click', () => setRole(i, btn.dataset.role))
    );
    $('.rr-remove', row).addEventListener('click', () => {
      parsed.splice(i, 1);
      renderRoles();
    });
    box.appendChild(row);
  });
  const hasClient = parsed.some((p) => p.role === 'client');
  $('#run-btn').disabled = !hasClient;
}
function setRole(i, role) {
  if (role === 'client') parsed.forEach((p, j) => (p.role = j === i ? 'client' : p.role === 'client' ? 'competitor' : p.role));
  else parsed[i].role = 'competitor';
  renderRoles();
}

// ---------- run analysis ----------
$('#run-btn').addEventListener('click', runAnalysis);
async function runAnalysis() {
  const name = $('#project-name').value.trim() || `Анализ ${new Date().toLocaleString('ru')}`;
  $('#run-btn').disabled = true;
  const card = $('#progress-card');
  const log = $('#progress-log');
  card.classList.remove('hidden');
  log.innerHTML = '';
  card.scrollIntoView({ behavior: 'smooth' });

  let jobId;
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, domains: parsed }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ошибка запуска');
    jobId = data.jobId;
  } catch (e) {
    appendLog(log, 'ОШИБКА: ' + e.message, 'err');
    $('#run-btn').disabled = false;
    return;
  }

  const es = new EventSource('/api/analyze/stream/' + jobId);
  es.addEventListener('log', (ev) => {
    const { message } = JSON.parse(ev.data);
    let cls = '';
    if (message.startsWith('===')) cls = 'head';
    else if (/готово|сохран|ok/i.test(message)) cls = 'ok';
    else if (/ОШИБКА|недоступ/i.test(message)) cls = 'err';
    appendLog(log, message, cls);
  });
  es.addEventListener('done', async (ev) => {
    es.close();
    const { projectId, error } = JSON.parse(ev.data);
    if (error) {
      appendLog(log, 'Завершено с ошибкой: ' + error, 'err');
      $('#run-btn').disabled = false;
      toast('Анализ завершился с ошибкой', true);
      return;
    }
    appendLog(log, '✔ Готово! Открываем дашборд…', 'ok');
    await loadSaved();
    await openProject(projectId);
  });
  es.onerror = () => { es.close(); $('#run-btn').disabled = false; };
}
function appendLog(log, msg, cls) {
  const line = el('div', 'pl-line' + (cls ? ' pl-' + cls : ''), esc(msg));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ---------- load & render dashboard ----------
async function openProject(id) {
  try {
    const res = await fetch('/api/project/' + id);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'не найдено');
    currentProject = data;
    $('#nav-dashboard').disabled = false;
    setSavedOpen(false); // дашборд открывают перед клиентом — прячем чужие проекты
    showView('dashboard');
    renderDashboard(data);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderDashboard(p) {
  clearCharts();
  const c = p.comparison;
  const domainsMeta = p.snapshots.map((s) => ({ domain: s.domain, role: s.role }));
  const colors = domainColors(domainsMeta);
  const client = p.snapshots.find((s) => s.role === 'client');
  const container = $('#dash-content');
  container.innerHTML = '';

  // header
  const head = el('div', 'dash-head');
  head.innerHTML = `
    <div class="dash-title">
      <h1 id="report-title" class="editable-title" contenteditable="true" spellcheck="false" title="Нажмите, чтобы переименовать отчёт">${esc(p.name)}</h1>
      <div class="dash-domains">${domainsMeta
        .map((d) => `<span class="chip ${d.role === 'client' ? 'client' : 'comp'}">${d.role === 'client' ? '★ ' : ''}${esc(d.domain)}</span>`)
        .join('')}</div>
    </div>
    <div class="dash-actions">
      <button class="btn btn-primary" id="export-doc" style="margin-top:0">⭳ Экспорт в Word</button>
      <button class="btn btn-ghost" id="export-btn" style="margin-top:0">JSON</button>
      <button class="btn btn-ghost" id="new-btn" style="margin-top:0">＋ Новый</button>
    </div>`;
  container.appendChild(head);

  // KPI row
  const kpis = el('div', 'kpi-grid');
  const clientCited = client ? client.ai_cited_count : 0;
  const topComp = c.headToHead;
  const fc = c.forecast || {};
  kpis.innerHTML = `
    ${kpiCard('ИИ-цитирования клиента', fmt(clientCited), client ? esc(client.domain) : '—', 'good')}
    ${kpiCard('Лидер по ИИ-выдаче', topComp ? fmt(topComp.competitor_ai_cited) : '—', topComp ? esc(topComp.competitor) : 'нет конкурентов', 'warn')}
    ${kpiCard('Упущенная семантика', fmt(c.gap_total || 0), 'запросов, где нас нет в ИИ', 'danger')}
    ${kpiCard('Потенциал трафика/мес', fmtShort(fc.potential_ai_traffic || 0), 'при цитировании в Алисе', 'accent')}
  `;
  container.appendChild(kpis);

  // head-to-head banner
  if (topComp && topComp.gap_ratio) {
    const banner = el('div', 'panel');
    banner.style.marginBottom = '18px';
    const behind = topComp.competitor_ai_cited - topComp.client_ai_cited;
    banner.innerHTML = `<div style="font-size:15px;line-height:1.6">
      Сильнейший конкурент <b style="color:var(--comp)">${esc(topComp.competitor)}</b> процитирован в ответах Алисы
      <b style="color:var(--warn)">в ${topComp.gap_ratio}× чаще</b>, чем клиент
      (${fmt(topComp.competitor_ai_cited)} против ${fmt(topComp.client_ai_cited)}).
      Это <b style="color:var(--danger)">${fmt(behind)}</b> запросов, где клиента ещё нет в ИИ-выдаче — и где он теряет обращения.</div>`;
    container.appendChild(banner);
  }

  // charts row 1: leaderboard bar + radar
  const row1 = el('div', 'grid-2 wide');
  row1.appendChild(panel('ИИ-видимость: цитирования в ответах Алисы', 'Сколько запросов, где сайт указан источником в ИИ-ответе', 'chart-bar-cited', 'tall'));
  row1.appendChild(panel('Профиль по критериям', 'Нормализованное сравнение 0–100 по всем метрикам', 'chart-radar', 'tall'));
  container.appendChild(row1);

  // charts row 2: reach bar + organic top bar
  const row2 = el('div', 'grid-2');
  row2.appendChild(panel('ИИ-охват: суммарная частотность', 'Сумма частотности (Wordstat) по процитированным запросам', 'chart-reach'));
  row2.appendChild(panel('Органическая сила: ТОП-5 / 10 / 50', 'Число запросов в топе органики Яндекса', 'chart-organic'));
  container.appendChild(row2);

  // semantic gap
  container.appendChild(sectionTitle('Упущенная семантика — точки роста клиента'));
  container.appendChild(gapPanel(c, colors));

  // strengths
  if (c.strengths && c.strengths.length) {
    container.appendChild(sectionTitle('Сильные стороны клиента — где он уже впереди'));
    container.appendChild(strengthsPanel(c));
  }

  // forecast
  container.appendChild(sectionTitle('Прогноз: что даёт продвижение по этой семантике'));
  container.appendChild(forecastPanel(c.forecast));

  // AI insights
  container.appendChild(sectionTitle('Выводы ИИ и план работ'));
  const insightsWrap = el('div', 'insights', '');
  insightsWrap.id = 'insights-wrap';
  container.appendChild(insightsWrap);
  renderInsights(p.insights);

  // wire buttons
  $('#new-btn').addEventListener('click', () => showView('setup'));
  $('#export-btn').addEventListener('click', () => exportProject(p));
  $('#export-doc').addEventListener('click', () => exportDoc(p));
  wireTitleEdit(p);

  // draw charts (after DOM in place)
  requestAnimationFrame(() => drawCharts(p, colors));
}

// Inline rename of the report title (persists to project + sidebar + docx name).
function wireTitleEdit(p) {
  const t = $('#report-title');
  if (!t) return;
  const commit = async () => {
    const name = t.textContent.trim().replace(/\s+/g, ' ');
    if (!name || name === p.name) {
      t.textContent = p.name;
      return;
    }
    try {
      const res = await fetch('/api/project/' + p.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ошибка');
      p.name = data.name;
      if (currentProject) currentProject.name = data.name;
      t.textContent = data.name;
      toast('Название отчёта обновлено');
      loadSaved();
    } catch (e) {
      t.textContent = p.name;
      toast('Не удалось переименовать: ' + e.message, true);
    }
  };
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    if (e.key === 'Escape') { t.textContent = p.name; t.blur(); }
  });
  t.addEventListener('blur', commit);
}

function kpiCard(label, value, sub, kind) {
  const cls = { good: 'client', warn: '', danger: 'danger', accent: 'accent' }[kind] || '';
  const boxCls = { good: 'good', warn: 'warn', danger: '', accent: '' }[kind] || '';
  return `<div class="kpi ${boxCls}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value ${cls}">${value}</div>
    <div class="kpi-sub">${esc(sub)}</div>
  </div>`;
}
function panel(title, desc, canvasId, extra) {
  const p = el('div', 'panel');
  p.innerHTML = `<div class="panel-h"><h3>${esc(title)}</h3></div>
    <div class="panel-desc">${esc(desc)}</div>
    <div class="chart-wrap ${extra || ''}"><canvas id="${canvasId}"></canvas></div>`;
  return p;
}
function sectionTitle(t) {
  return el('div', 'section-title', `${esc(t)}<span class="st-line"></span>`);
}

// ---------- gap / strengths panels ----------
function gapPanel(c, colors) {
  const p = el('div', 'panel');
  const rows = c.gap.slice(0, 60);
  if (!rows.length) {
    p.innerHTML = '<div class="gen-state">Нет упущенной семантики: клиент присутствует во всех ИИ-запросах конкурентов. Отличный результат!</div>';
    return p;
  }
  const body = rows
    .map(
      (g) => `<tr>
      <td class="q-text" title="${esc(g.query_text)}">${esc(g.query_text)}</td>
      <td class="num"><span class="ws-pill">${g.freq ? fmt(g.freq) : '—'}</span></td>
      <td class="num"><span class="cov-pill">${g.coverage} из ${c.competitors.length}</span></td>
      <td class="mini-tag">${esc(g.competitors.slice(0, 3).join(', '))}${g.competitors.length > 3 ? '…' : ''}</td>
    </tr>`
    )
    .join('');
  p.innerHTML = `
    <div class="panel-desc">Запросы, где конкуренты процитированы в ИИ-выдаче Алисы, а клиента там нет. Всего: <b style="color:var(--danger)">${fmt(c.gap_total)}</b> запросов. Показаны топ-60 по частотности.</div>
    <div class="tbl-scroll tbl-wrap"><table class="data">
      <thead><tr><th>Запрос</th><th class="num">Частотность</th><th class="num">Охват конкурентов</th><th>Кто процитирован</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  return p;
}
function strengthsPanel(c) {
  const p = el('div', 'panel');
  const rows = c.strengths.slice(0, 40);
  const body = rows
    .map(
      (s) => `<tr><td class="q-text" title="${esc(s.query_text)}">${esc(s.query_text)}</td>
        <td class="num"><span class="ws-pill">${s.freq ? fmt(s.freq) : '—'}</span></td></tr>`
    )
    .join('');
  p.innerHTML = `
    <div class="panel-desc">Запросы, где в ИИ-ответах Алисы процитирован <b style="color:var(--client)">только клиент</b> и никого из конкурентов. Всего: <b style="color:var(--client)">${fmt(c.strengths_total)}</b>. Это уникальные преимущества, которые нужно удержать и усилить.</div>
    <div class="tbl-scroll tbl-wrap"><table class="data">
      <thead><tr><th>Запрос</th><th class="num">Частотность</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  return p;
}
function forecastPanel(fc) {
  const p = el('div', 'panel');
  if (!fc) {
    p.innerHTML = '<div class="gen-state">Прогноз недоступен — не выбран клиент.</div>';
    return p;
  }
  p.innerHTML = `
    <div class="forecast">
      <div class="fc-box">
        <div class="fc-val" style="color:var(--muted)">${fmtShort(fc.current_ai_traffic)}</div>
        <div class="fc-lbl">Текущий трафик из ИИ-выдачи (оценка/мес)</div>
      </div>
      <div class="fc-box hi">
        <div class="fc-val">+${fmtShort(fc.potential_ai_traffic)}</div>
        <div class="fc-lbl">Доп. трафик/мес при цитировании по упущенной семантике</div>
      </div>
      <div class="fc-box">
        <div class="fc-val" style="color:var(--accent)">${fmtShort(fc.potential_ai_traffic_top3)}</div>
        <div class="fc-lbl">Если также выйти в ТОП-3 органики по этим запросам</div>
      </div>
    </div>
    <div class="fc-note">Модель: ${fmt(fc.gap_queries)} упущенных запросов × консервативные ${fc.visits_per_ai_cited} визитов/мес на запрос при цитировании в ИИ-ответе
      (и ${fc.visits_per_top3} визитов при выходе в ТОП-3 органики). Допущения по трафику на запрос настраиваются; частотность (Wordstat)
      по каждому запросу — в таблице упущенной семантики выше для приоритизации.</div>`;
  return p;
}

// ---------- charts ----------
function chartTheme() {
  const light = (document.documentElement.dataset.theme || 'dark') === 'light';
  return {
    tick: light ? '#55637f' : '#8b98b8',
    grid: light ? 'rgba(20,28,51,0.08)' : 'rgba(36,48,79,0.6)',
  };
}
function baseOpts(extra = {}) {
  const { tick } = chartTheme();
  return Object.assign(
    {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: tick, font: { size: 11 } } } },
    },
    extra
  );
}
function drawCharts(p, colors) {
  const snaps = p.snapshots;
  const c = p.comparison;
  const { grid: gridColor, tick: tickColor } = chartTheme();

  // Bar: AI cited (sorted from leaderboard)
  const lb = c.leaderboard;
  charts.push(
    new Chart($('#chart-bar-cited'), {
      type: 'bar',
      data: {
        labels: lb.map((d) => d.domain),
        datasets: [
          {
            label: 'ИИ-цитирований',
            data: lb.map((d) => d.ai_cited),
            backgroundColor: lb.map((d) => colors[d.domain] || '#6d8bff'),
            borderRadius: 8,
          },
        ],
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: tickColor } },
          y: { grid: { display: false }, ticks: { color: tickColor, font: { weight: '600' } } },
        },
      }),
    })
  );

  // Radar
  const radarLabels = c.radar.map((r) => r.axis);
  const radarDatasets = snaps.map((s) => ({
    label: s.domain,
    data: c.radar.map((ax) => (ax.values.find((v) => v.domain === s.domain) || {}).value || 0),
    borderColor: colors[s.domain],
    backgroundColor: (colors[s.domain] || '#6d8bff') + '22',
    borderWidth: 2,
    pointBackgroundColor: colors[s.domain],
  }));
  charts.push(
    new Chart($('#chart-radar'), {
      type: 'radar',
      data: { labels: radarLabels, datasets: radarDatasets },
      options: baseOpts({
        scales: {
          r: {
            angleLines: { color: gridColor },
            grid: { color: gridColor },
            pointLabels: { color: tickColor, font: { size: 11 } },
            ticks: { display: false, backdropColor: 'transparent' },
            suggestedMin: 0,
            suggestedMax: 100,
          },
        },
      }),
    })
  );

  // Reach bar
  charts.push(
    new Chart($('#chart-reach'), {
      type: 'bar',
      data: {
        labels: lb.map((d) => d.domain),
        datasets: [
          {
            label: 'ИИ-охват (Σ частотности)',
            data: lb.map((d) => d.ai_reach),
            backgroundColor: lb.map((d) => (colors[d.domain] || '#6d8bff') + 'cc'),
            borderRadius: 8,
          },
        ],
      },
      options: baseOpts({
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: tickColor } },
          y: { grid: { color: gridColor }, ticks: { color: tickColor, callback: (v) => fmtShort(v) } },
        },
      }),
    })
  );

  // Organic top-5/10/50 grouped
  charts.push(
    new Chart($('#chart-organic'), {
      type: 'bar',
      data: {
        labels: snaps.map((s) => s.domain),
        datasets: [
          { label: 'ТОП-5', data: snaps.map((s) => s.it5), backgroundColor: '#34d9a8', borderRadius: 6 },
          { label: 'ТОП-10', data: snaps.map((s) => s.it10), backgroundColor: '#6d8bff', borderRadius: 6 },
          { label: 'ТОП-50', data: snaps.map((s) => s.it50), backgroundColor: '#9a6dff', borderRadius: 6 },
        ],
      },
      options: baseOpts({
        scales: {
          x: { grid: { display: false }, ticks: { color: tickColor } },
          y: { grid: { color: gridColor }, ticks: { color: tickColor, callback: (v) => fmtShort(v) } },
        },
      }),
    })
  );
}

// ---------- insights ----------
async function renderInsights(insights) {
  const wrap = $('#insights-wrap');
  if (!insights) {
    wrap.innerHTML = `<div class="gen-state">
      <p>Сгенерировать экспертные выводы, разбор сильных сторон и план работ на основе цифр (OpenAI).</p>
      <button class="btn btn-primary" id="gen-insights" style="margin-top:14px">✦ Сгенерировать выводы и план работ</button>
    </div>`;
    $('#gen-insights').addEventListener('click', genInsights);
    return;
  }
  const i = insights;
  const block = (title, items, cls) =>
    items && items.length
      ? `<div class="ins-block ${cls || ''}"><h4>${esc(title)}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
      : '';
  const plan = (i.work_plan || [])
    .map(
      (ph) => `<div class="plan-phase">
      <div class="plan-phase-h"><span class="pp-name">${esc(ph.phase || '')}</span><span class="pp-time">${esc(ph.timeframe || '')}</span></div>
      <ul class="plan-actions">${(ph.actions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      ${ph.kpi ? `<div class="plan-kpi">KPI: ${esc(ph.kpi)}</div>` : ''}
    </div>`
    )
    .join('');
  wrap.innerHTML = `
    ${i.verdict ? `<div class="verdict">${esc(i.verdict)}</div>` : ''}
    <div class="ins-grid">
      ${block('Сильные стороны клиента', i.client_strengths, 'client')}
      ${block('Сильные стороны конкурентов', i.competitor_strengths, 'comp')}
    </div>
    <div class="ins-grid">
      ${block('Почему необходимо продвигаться сейчас', i.why_now, 'why')}
      ${i.opportunity_summary ? `<div class="ins-block"><h4>Размер возможности</h4><p style="font-size:13px;color:var(--muted);line-height:1.6">${esc(i.opportunity_summary)}</p></div>` : ''}
    </div>
    ${plan ? `<div class="section-title" style="margin-top:24px;font-size:15px">План работ<span class="st-line"></span></div><div class="plan">${plan}</div>` : ''}
    ${i.pitch ? `<div class="pitch"><div class="pitch-label">Речь для клиента</div>${esc(i.pitch)}</div>` : ''}
    <div style="margin-top:16px"><button class="btn btn-ghost" id="regen-insights">↻ Перегенерировать</button>
      <span class="mini-tag" style="margin-left:10px">${i._model ? 'модель: ' + esc(i._model) : ''}</span></div>`;
  $('#regen-insights') && $('#regen-insights').addEventListener('click', genInsights);
}
async function genInsights() {
  const wrap = $('#insights-wrap');
  wrap.innerHTML = '<div class="gen-state"><span class="spinner"></span> Анализируем цифры и готовим выводы…</div>';
  try {
    const res = await fetch('/api/project/' + currentProject.id + '/insights', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ошибка генерации');
    currentProject.insights = data;
    renderInsights(data);
    toast('Выводы готовы');
  } catch (e) {
    wrap.innerHTML = `<div class="gen-state pl-err">Не удалось сгенерировать: ${esc(e.message)}</div>
      <div style="text-align:center"><button class="btn btn-primary" id="gen-insights">Повторить</button></div>`;
    $('#gen-insights').addEventListener('click', genInsights);
  }
}

// ---------- export ----------
// Composite a chart canvas onto a white background so it reads on a white Word page.
function chartPng(id) {
  const cv = document.getElementById(id);
  if (!cv) return null;
  try {
    const t = document.createElement('canvas');
    t.width = cv.width;
    t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, t.width, t.height);
    ctx.drawImage(cv, 0, 0);
    return t.toDataURL('image/png');
  } catch {
    return null;
  }
}
async function exportDoc(p) {
  const btn = $('#export-doc');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Готовим Word…'; }
  try {
    const charts = {
      cited: chartPng('chart-bar-cited'),
      radar: chartPng('chart-radar'),
      reach: chartPng('chart-reach'),
      organic: chartPng('chart-organic'),
    };
    const res = await fetch('/api/project/' + p.id + '/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ charts }),
    });
    if (!res.ok) throw new Error('ошибка сервера ' + res.status);
    const blob = await res.blob();
    const safeName = (p.name || `ai-radar-${p.id}`)
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('Документ Word готов — с графиками');
  } catch (e) {
    toast('Не удалось сформировать Word: ' + e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}
function exportProject(p) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ai-radar-${p.id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- saved projects ----------
async function loadSaved() {
  try {
    const res = await fetch('/api/projects');
    const list = await res.json();
    const box = $('#saved-list');
    box.innerHTML = '';
    const counter = $('#saved-count');
    if (counter) counter.textContent = list.length || '';
    if (!list.length) {
      box.appendChild(el('div', 'mini-tag', 'Пока нет сохранённых проектов.'));
      return;
    }
    for (const pr of list) {
      const item = el('div', 'saved-item');
      const date = new Date(pr.created_at).toLocaleDateString('ru');
      item.innerHTML = `<div class="si-name">${esc(pr.name)} <span class="si-del" title="Удалить">✕</span></div>
        <div class="si-meta"><span>${pr.domains} сайт(ов)</span><span>${date}</span></div>`;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('si-del')) {
          e.stopPropagation();
          delProject(pr.id);
          return;
        }
        openProject(pr.id);
      });
      box.appendChild(item);
    }
  } catch {}
}
async function delProject(id) {
  if (!confirm('Удалить проект из памяти?')) return;
  await fetch('/api/project/' + id, { method: 'DELETE' });
  await loadSaved();
  if (currentProject && currentProject.id === id) {
    currentProject = null;
    $('#nav-dashboard').disabled = true;
    showView('setup');
  }
  toast('Проект удалён');
}

// Список сохранённых проектов свёрнут при каждой загрузке страницы и не запоминает
// состояние: экран часто показывают клиенту, а в списке — названия других клиентов.
function setSavedOpen(open) {
  const box = $('#saved-box');
  if (!box) return;
  box.classList.toggle('collapsed', !open);
  const btn = $('#saved-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(open));
    btn.title = open ? 'Скрыть список сохранённых проектов' : 'Показать список сохранённых проектов';
  }
}
function initSavedPanel() {
  setSavedOpen(false);
  $('#saved-toggle').addEventListener('click', () => {
    setSavedOpen($('#saved-box').classList.contains('collapsed'));
  });
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
}
function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
  $('#theme-toggle').addEventListener('click', () => {
    const next = (document.documentElement.dataset.theme || 'dark') === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', next);
    applyTheme(next);
    // Recolor charts to match the theme.
    if (currentProject && !$('#view-dashboard').classList.contains('hidden')) {
      renderDashboard(currentProject);
    }
  });
}

// ---------- init ----------
async function init() {
  initTheme();
  initSavedPanel();
  try {
    const cfg = await (await fetch('/api/config')).json();
    const badge = $('#cfg-badge');
    const ok = cfg.keyso && cfg.openai;
    badge.className = 'badge ' + (ok ? 'ok' : cfg.keyso ? '' : 'err');
    badge.textContent = `База ${cfg.base} · Keys.so ${cfg.keyso ? '✓' : '✕'} · OpenAI ${cfg.openai ? '✓' : '✕'}`;
  } catch {}
  await loadSaved();
}
init();
