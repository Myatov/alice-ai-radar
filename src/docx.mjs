// Генерация настоящего .docx (OOXML) в чистом Node — без внешних зависимостей.
// Свой ZIP-архиватор (метод STORE + CRC32) + сборка word/document.xml, стилей и
// встраивание PNG-графиков как рисунков. Интервалы абзацев и поля ячеек заданы
// компактно на уровне стилей, поэтому строки таблиц не «раздуваются».

// ---------- ZIP (STORE) ----------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (CRC_TABLE = t);
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------- helpers ----------
const nf = new Intl.NumberFormat('ru-RU');
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const CTRL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(CTRL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const roleRu = (r) => (r === 'client' ? 'Клиент' : 'Конкурент');

function run(text, o = {}) {
  let rPr = '';
  if (o.font) rPr += `<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>`;
  if (o.b) rPr += '<w:b/>';
  if (o.i) rPr += '<w:i/>';
  if (o.color) rPr += `<w:color w:val="${o.color}"/>`;
  if (o.sz) rPr += `<w:sz w:val="${o.sz}"/><w:szCs w:val="${o.sz}"/>`;
  const rprXml = rPr ? `<w:rPr>${rPr}</w:rPr>` : '';
  const parts = String(text == null ? '' : text).split('\n');
  const runs = parts
    .map((seg, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(seg)}</w:t>`)
    .join('');
  return `<w:r>${rprXml}${runs}</w:r>`;
}
function para(runsXml, o = {}) {
  const after = o.after == null ? 120 : o.after;
  const before = o.before == null ? 0 : o.before;
  const line = o.line || 240;
  let pPr = '<w:pPr>';
  if (o.borderLeft)
    pPr += `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${o.borderLeft}"/></w:pBdr>`;
  if (o.shd) pPr += `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>`;
  pPr += `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>`;
  if (o.indLeft) pPr += `<w:ind w:left="${o.indLeft}" w:hanging="200"/>`;
  if (o.align) pPr += `<w:jc w:val="${o.align}"/>`;
  pPr += '</w:pPr>';
  return `<w:p>${pPr}${runsXml || ''}</w:p>`;
}
const emptyP = () => para('', { after: 60 });
const h1 = (t) => para(run(t, { b: true, sz: 44, color: '3A4FD6' }), { after: 40, before: 0 });
const h2 = (t) => para(run(t, { b: true, sz: 30, color: '2C3A86' }), { before: 260, after: 90 });
const h3 = (t, color) => para(run(t, { b: true, sz: 24, color: color || '2C3A86' }), { before: 170, after: 40 });
const noteP = (t) => para(run(t, { sz: 17, color: '6A7699' }), { after: 80 });
const bullets = (arr, color) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => para(run('•  ' + x, { sz: 20, color: color || null }), { indLeft: 360, after: 40 }))
    .join('');

// table primitives
function tc(width, contentXml, o = {}) {
  const shd = o.shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>` : '';
  const span = o.span ? `<w:gridSpan w:val="${o.span}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span}${shd}<w:vAlign w:val="${o.valign || 'center'}"/></w:tcPr>${contentXml}</w:tc>`;
}
const tr = (cells) => `<w:tr>${cells.join('')}</w:tr>`;
function tbl(colW, rows) {
  const grid = colW.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  const borders = `<w:tblBorders>${sides.map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D3DBF0"/>`).join('')}</w:tblBorders>`;
  const cellMar =
    '<w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar>';
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>${borders}${cellMar}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
}
function dataTable(headers, rows, colW, aligns = []) {
  const cp = (t, o) => para(t, { after: 0, before: 0, align: o && o.align });
  const head = tr(
    headers.map((hh, i) => tc(colW[i], cp(run(hh, { b: true, color: '2C3A86', sz: 16 }), { align: aligns[i] }), { shd: 'EEF1FB' }))
  );
  const body = rows.map((rowCells, ri) =>
    tr(
      rowCells.map((cell, ci) => {
        const shd = ri % 2 === 1 ? 'F7F9FE' : null;
        const rn = typeof cell === 'object' ? cell.run : run(String(cell), { sz: 18 });
        return tc(colW[ci], cp(rn, { align: aligns[ci] }), { shd });
      })
    )
  );
  return tbl(colW, [head, ...body]);
}

// PNG dimensions from IHDR
function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h) return null;
  return { w, h };
}
const PX_TO_EMU = 9525;
function imageP(relId, id, cx, cy, name) {
  return `<w:p><w:pPr><w:spacing w:before="120" w:after="40" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// ---------- main ----------
export function buildDocx(project, c, insights, charts) {
  const created = new Date(project.created_at).toLocaleString('ru-RU');
  const fc = c.forecast || {};
  const h2h = c.headToHead;
  const lb = c.leaderboard || [];

  const media = []; // {name, data}
  const imageRels = []; // {id, target}
  let relCounter = 1; // rId1 = styles
  let picId = 1;
  const blocks = [];
  const push = (x) => x && blocks.push(x);

  push(h1('Анализ ИИ-видимости · Яндекс Алиса'));
  push(para(run(`${project.name} · База Keys.so: ${project.base} · Сформировано: ${created}`, { sz: 18, color: '6A7699' }), { after: 100 }));

  // Сайты
  if (lb.length) {
    const w = Math.floor(9638 / lb.length);
    const cells = lb.map((r) => {
      const isC = r.role === 'client';
      const inner =
        para(run((isC ? '★ ' : '') + r.domain, { b: true, sz: 20, color: isC ? '0F9D6E' : 'D9662A' }), { after: 0, before: 20, align: 'center' }) +
        para(run(roleRu(r.role), { sz: 15, color: '6A7699' }), { after: 20, before: 0, align: 'center' });
      return tc(w, inner, { shd: isC ? 'E6F7F0' : 'FDEEE5' });
    });
    push(tbl(lb.map(() => w), [tr(cells)]));
    push(emptyP());
  }

  // KPI
  push(h2('Ключевые показатели'));
  const kW = 2409;
  const kpiCell = (val, label, color) =>
    tc(
      kW,
      para(run(val, { b: true, sz: 40, color }), { after: 20, before: 60, align: 'center' }) +
        para(run(label, { sz: 15, color: '6A7699' }), { after: 60, before: 0, align: 'center' }),
      {}
    );
  push(
    tbl(
      [kW, kW, kW, kW],
      [
        tr([
          kpiCell(fmt(fc.current_ai_cited || 0), 'ИИ-цитирований клиента', '0F9D6E'),
          kpiCell(h2h ? fmt(h2h.competitor_ai_cited) : '—', 'Лидер по ИИ-выдаче', 'D9662A'),
          kpiCell(fmt(c.gap_total || 0), 'Упущенная семантика', 'E23B5B'),
          kpiCell('+' + fmt(fc.potential_ai_traffic || 0), 'Потенциал трафика/мес', '3A4FD6'),
        ]),
      ]
    )
  );
  push(emptyP());

  // Head-to-head
  if (h2h && h2h.gap_ratio) {
    const runs =
      run('Сильнейший конкурент ', { sz: 21 }) +
      run(h2h.competitor, { b: true, color: 'D9662A', sz: 21 }) +
      run(' процитирован в ответах Алисы ', { sz: 21 }) +
      run(`в ${h2h.gap_ratio}× чаще`, { b: true, color: 'C1870C', sz: 21 }) +
      run(`, чем клиент (${fmt(h2h.competitor_ai_cited)} против ${fmt(h2h.client_ai_cited)}). `, { sz: 21 }) +
      run(`Это ${fmt(h2h.competitor_ai_cited - h2h.client_ai_cited)} запросов, где клиента ещё нет в ИИ-выдаче — и где он теряет обращения.`, { b: true, sz: 21 });
    push(para(runs, { shd: 'F2F5FF', borderLeft: '3A4FD6', after: 140, before: 40 }));
  }

  // Сравнение
  push(h2('Сравнение сайтов по критериям'));
  push(
    dataTable(
      ['Сайт', 'Роль', 'ИИ-цитир.', 'ИИ-охват', 'ТОП-5', 'ТОП-10', 'ТОП-50'],
      lb.map((r) => [
        { run: run(r.domain, { b: r.role === 'client', sz: 18, color: r.role === 'client' ? '0F9D6E' : null }) },
        roleRu(r.role),
        fmt(r.ai_cited),
        fmt(r.ai_reach),
        fmt(r.it5),
        fmt(r.it10),
        fmt(r.it50),
      ]),
      [2600, 1200, 1300, 1300, 1046, 1046, 1146],
      ['left', 'left', 'right', 'right', 'right', 'right', 'right']
    )
  );
  push(emptyP());

  // Графики
  const addChart = (dataUrl, caption, targetPx) => {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return;
    let buf;
    try {
      buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    } catch {
      return;
    }
    const sz = pngSize(buf);
    if (!sz) return;
    const name = `image${media.length + 1}.png`;
    media.push({ name: `word/media/${name}`, data: buf });
    const relId = `rId${++relCounter}`;
    imageRels.push({ id: relId, target: `media/${name}` });
    const cx = Math.round(targetPx * PX_TO_EMU);
    const cy = Math.round(cx * (sz.h / sz.w));
    push(imageP(relId, ++picId, cx, cy, name));
    push(para(run(caption, { i: true, sz: 16, color: '6A7699' }), { after: 120, before: 0, align: 'center' }));
  };
  if (charts && (charts.cited || charts.radar || charts.reach || charts.organic)) {
    push(h2('Графики сравнения'));
    addChart(charts.cited, 'ИИ-видимость: цитирования в ответах Алисы', 600);
    addChart(charts.radar, 'Профиль по критериям (нормализовано 0–100)', 430);
    addChart(charts.reach, 'ИИ-охват: суммарная частотность', 600);
    addChart(charts.organic, 'Органическая сила: ТОП-5 / 10 / 50', 600);
  }

  // Прогноз
  push(h2('Прогноз трафика'));
  const fW = 3213;
  const fcCell = (val, label, color) =>
    tc(
      fW,
      para(run(val, { b: true, sz: 34, color }), { after: 20, before: 60, align: 'center' }) +
        para(run(label, { sz: 15, color: '6A7699' }), { after: 60, before: 0, align: 'center' }),
      {}
    );
  push(
    tbl(
      [fW, fW, fW],
      [
        tr([
          fcCell(fmt(fc.current_ai_traffic || 0), 'Текущий трафик из ИИ-выдачи /мес', '6A7699'),
          fcCell('+' + fmt(fc.potential_ai_traffic || 0), 'Доп. трафик при цитировании', '0F9D6E'),
          fcCell(fmt(fc.potential_ai_traffic_top3 || 0), 'При выходе в ТОП-3 органики', '3A4FD6'),
        ]),
      ]
    )
  );
  push(noteP(`Модель: ${fmt(fc.gap_queries || 0)} упущенных запросов × ${fc.visits_per_ai_cited || 0} визитов/мес на запрос при цитировании в ИИ-ответе (и ${fc.visits_per_top3 || 0} при ТОП-3 органики). Допущения настраиваются.`));
  push(emptyP());

  // Упущенная семантика
  push(h2('Упущенная семантика (точки роста клиента)'));
  push(noteP(`Запросы, где конкуренты процитированы в ИИ-выдаче Алисы, а клиента там нет. Всего: ${fmt(c.gap_total || 0)}. Показаны топ-100 по частотности.`));
  const gapRows = (c.gap || [])
    .slice(0, 100)
    .map((g) => [g.query_text, g.freq ? fmt(g.freq) : '—', `${g.coverage} из ${c.competitors.length}`, (g.competitors || []).join(', ')]);
  push(
    gapRows.length
      ? dataTable(['Запрос', 'Частотность', 'Охват', 'Кто процитирован'], gapRows, [4500, 1300, 1400, 2438], ['left', 'right', 'center', 'left'])
      : noteP('Нет упущенной семантики.')
  );
  push(emptyP());

  // Сильные стороны
  push(h2('Сильные стороны клиента'));
  push(noteP(`Запросы, где в ИИ-ответах процитирован только клиент. Всего: ${fmt(c.strengths_total || 0)}. Показаны топ-60.`));
  const strRows = (c.strengths || []).slice(0, 60).map((s) => [s.query_text, s.freq ? fmt(s.freq) : '—']);
  push(strRows.length ? dataTable(['Запрос', 'Частотность'], strRows, [7300, 2338], ['left', 'right']) : noteP('Нет данных.'));
  push(emptyP());

  // Выводы OpenAI
  push(h2('Выводы и рекомендации'));
  if (insights) {
    if (insights.verdict)
      push(para(run(insights.verdict, { b: true, sz: 24 }), { shd: 'F2F5FF', borderLeft: '3A4FD6', after: 120, before: 40 }));
    if (insights.client_strengths) {
      push(h3('Сильные стороны клиента', '0F9D6E'));
      push(bullets(insights.client_strengths));
    }
    if (insights.competitor_strengths) {
      push(h3('Сильные стороны конкурентов', 'D9662A'));
      push(bullets(insights.competitor_strengths));
    }
    if (insights.why_now) {
      push(h3('Почему необходимо продвигаться сейчас'));
      push(bullets(insights.why_now));
    }
    if (insights.opportunity_summary) {
      push(h3('Размер возможности'));
      push(para(run(insights.opportunity_summary, { sz: 21 }), { after: 100 }));
    }
    if (Array.isArray(insights.work_plan) && insights.work_plan.length) {
      push(h2('План работ'));
      for (const ph of insights.work_plan) {
        push(
          para(run(ph.phase || '', { b: true, sz: 22 }) + run(`   —   ${ph.timeframe || ''}`, { i: true, color: '3A4FD6', sz: 20 }), {
            before: 140,
            after: 30,
          })
        );
        push(bullets(ph.actions));
        if (ph.kpi) push(para(run('KPI: ', { b: true, color: 'C1870C', sz: 19 }) + run(ph.kpi, { color: 'C1870C', sz: 19 }), { indLeft: 360, after: 80 }));
      }
    }
    if (insights.pitch) {
      push(h2('Коммерческое предложение'));
      push(para(run(insights.pitch, { sz: 22 }), { shd: 'EEF1FB', after: 120, before: 40 }));
    }
  } else {
    push(noteP('Выводы OpenAI ещё не сгенерированы. Нажмите «Сгенерировать выводы» в дашборде и повторите экспорт.'));
  }

  push(para(run(`Отчёт подготовлен сервисом «Радар ИИ-видимости» по данным Keys.so (ИИ-выдача Яндекс Алисы)${insights && insights._model ? ` · выводы: ${insights._model}` : ''}.`, { sz: 16, color: '9AA4BF' }), { before: 200 }));
  push(emptyP());

  // ---------- сборка частей ----------
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${blocks.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:color w:val="1A2238"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const relItems = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    ...imageRels.map(
      (im) => `<Relationship Id="${im.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${im.target}"/>`
    ),
  ].join('');
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relItems}</Relationships>`;

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
    ...media,
  ];
  return zipStore(files);
}
