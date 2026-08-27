// OpenAI — превращает цифры сравнения в убедительный нарратив для клиента,
// разбор сильных сторон и конкретный план работ.
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const SYSTEM = `Ты — ведущий SEO-стратег и коммерческий директор агентства, специализирующегося на продвижении в ИИ-выдаче (Яндекс Алиса и нейросети).
Твоя задача — на основе данных сравнения видимости сайтов в ИИ-выдаче подготовить материал, который убедит потенциального клиента начать работу с агентством.
Пиши на русском, конкретно, с опорой на предоставленные цифры (не выдумывай новых чисел). Тон — экспертный, уверенный, ориентированный на выгоду клиента и бизнес-результат.
Отвечай СТРОГО валидным JSON без markdown-обёртки.`;

function buildPrompt(payload) {
  return `Данные анализа ИИ-видимости (Keys.so, ИИ-выдача Яндекс Алисы), база ${payload.base}.

САЙТ КЛИЕНТА: ${payload.client}
КОНКУРЕНТЫ: ${payload.competitors.join(', ')}

Ключевые метрики по каждому сайту (ai_cited — число запросов, где сайт процитирован в ответе Алисы; ai_reach — суммарная частотность этих запросов; it5/it10/it50 — число запросов в ТОП-5/10/50 органики):
${JSON.stringify(payload.leaderboard, null, 1)}

Прямое сравнение с сильнейшим конкурентом:
${JSON.stringify(payload.headToHead)}

Прогноз трафика (если клиент закроет семантический разрыв):
${JSON.stringify(payload.forecast)}

ТОП упущенной семантики (запросы, где конкуренты процитированы в ИИ-выдаче, а клиент — нет; freq — фразовая частотность Wordstat, показов/мес):
${JSON.stringify(payload.gapTop)}

Сильные стороны клиента (запросы, где процитирован только клиент):
${JSON.stringify(payload.strengthsTop)}

Верни JSON строго такой структуры:
{
  "verdict": "1-2 предложения — главный вывод: где клиент сейчас и почему нужно действовать",
  "client_strengths": ["3-5 пунктов сильных сторон клиента с опорой на цифры"],
  "competitor_strengths": ["3-5 пунктов, чем сильны ключевые конкуренты в ИИ-выдаче"],
  "why_now": ["3-4 аргумента, почему продвигаться по этой семантике НЕОБХОДИМО и именно сейчас"],
  "opportunity_summary": "абзац о размере упущенной возможности в терминах трафика/охвата на основе прогноза",
  "work_plan": [
    {"phase": "Название этапа", "timeframe": "напр. Месяц 1-2", "actions": ["конкретные действия"], "kpi": "измеримый результат"}
  ],
  "pitch": "короткая убедительная речь (5-7 предложений) для встречи с клиентом — почему начать работать именно с нами"
}
Сделай work_plan из 3-4 этапов. Опирайся на реальную упущенную семантику.`;
}

export async function generateInsights(payload) {
  if (!API_KEY) throw new Error('OPENAI_API_KEY не задан');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(payload) },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { verdict: content };
  }
  parsed._model = MODEL;
  parsed._generated_at = new Date().toISOString();
  return parsed;
}

export const aiConfig = { MODEL, KEY_SET: Boolean(API_KEY) };
