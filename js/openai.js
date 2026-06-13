// Распознавание заказов: Whisper (аудио → текст) + GPT-4o-mini (текст → позиции).
//
// Режимы (window.CONFIG.OPENAI_MODE):
//   "edge"   — запросы идут на Supabase Edge Function "openaiproxy",
//              ключ OpenAI хранится в секретах Supabase и НЕ попадает в браузер.
//   "direct" — запросы напрямую на api.openai.com с ключом из config.js.
//              ТОЛЬКО для локального теста.
//
// Системный промпт продублирован в supabase/functions/openaiproxy/index.ts —
// изменения вносить в оба файла синхронно.

(function () {
  const SYSTEM_PROMPT = `Ты — система распознавания заказов для поставщика HoReCa.
Клиент диктует заказ на русском, узбекском или смешанном русско-узбекском языке.
Текст уже прошёл предварительную нормализацию (числительные приведены к цифрам).
Извлеки список товаров и верни ТОЛЬКО валидный JSON:
{
  "client_name": "имя клиента если назвал",
  "client_comment": "уточнения, пометки",
  "repeat_last_order": true/false,
  "urgent": true/false,
  "items": [
    {
      "name": "точное название товара",
      "qty": число или null,
      "unit": "шт/уп/кг/л/пар/рул/пач/мешок/коробка/упаковка",
      "confidence": "high/medium/low",
      "confidence_score": 0-100,
      "corrected": true/false,
      "note": "пометка если что-то неясно"
    }
  ]
}
Правила:
- Название заведения (кафе, ресторан, магазин и т.д.) или имя клиента рядом со словом «это» — это client_name, а НЕ товар.
- В items только то, что заказывают: продукты, упаковка, посуда и т.д. Не добавляй в items название заведения или имя клиента.
- САМОИСПРАВЛЕНИЯ И УТОЧНЕНИЯ. Клиент часто называет одно число, потом говорит «ээ», «нет», «йук», «yo'q», «ne», «ya'ni» и называет другое число — это значит он ИСПРАВЛЯЕТ себя. Всегда бери ПОСЛЕДНЕЕ названное число, не первое. Пример: «2 штуки... ээ нет 200 штук» → qty=200. Пример: «вилок столько же» → то же количество что у предыдущего товара. Для таких позиций ставь corrected=true.
- ПОВТОРЫ. Если один и тот же товар упомянут несколько раз — используй последнюю, уточнённую версию (количество и единицу), не дублируй позицию.
- Узбекские единицы: dona=шт, ta=шт, juft=пар, qop=мешок, korobka=коробка, upakovka=упаковка.
- confidence_score (0–100) — насколько уверенно распознана позиция. Понижай его, если: количество не указано, название товара неясно, было самоисправление. Согласуй: confidence="low" при score<55, "medium" при 55–79, "high" при ≥80.
- Не придумывай количество если не сказано — ставь qty=null и понижай confidence_score.
- "как обычно" / "odatdagidek" — repeat_last_order=true`;

  const OPENAI_API = "https://api.openai.com/v1";

  function cfg() {
    if (!window.CONFIG) {
      throw new Error("config.js не подключён. Скопируйте config.example.js в config.js.");
    }
    return window.CONFIG;
  }

  function mode() {
    return cfg().OPENAI_MODE === "direct" ? "direct" : "edge";
  }

  function edgeUrl() {
    const fn = cfg().EDGE_FUNCTION_NAME || "openaiproxy";
    return String(cfg().SUPABASE_URL || "").replace(/\/+$/, "") + "/functions/v1/" + fn;
  }

  function edgeHeaders(extra) {
    const key = cfg().SUPABASE_ANON_KEY;
    return Object.assign(
      { apikey: key, Authorization: "Bearer " + key },
      extra || {}
    );
  }

  function directKey() {
    const key = cfg().OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_MODE="direct", но OPENAI_API_KEY пуст в config.js.');
    return key;
  }

  // Запрос к Edge Function с пометкой источника ошибки: серверные ошибки
  // (код функции в дашборде, секреты, OpenAI) не путаются с ошибками фронтенда.
  async function edgeRequest(options) {
    const fnName = cfg().EDGE_FUNCTION_NAME || "openaiproxy";
    let resp;
    try {
      resp = await fetch(edgeUrl(), options);
    } catch (e) {
      throw new Error("Edge Function «" + fnName + "» недоступна: " + (e && e.message ? e.message : e));
    }
    try {
      return await readJson(resp);
    } catch (e) {
      throw new Error("Edge Function «" + fnName + "» вернула ошибку: " + (e && e.message ? e.message : e));
    }
  }

  async function readJson(resp) {
    let data = null;
    try { data = await resp.json(); } catch (e) { /* не-JSON ответ */ }
    if (!resp.ok) {
      const msg = (data && (data.error && data.error.message || data.error || data.message)) || ("HTTP " + resp.status);
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return data || {};
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (e) { /* пробуем вытащить объект */ }
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e) { /* без шансов */ }
    }
    throw new Error("Модель вернула невалидный JSON.");
  }

  // Аудиофайл (.ogg/.mp3/.wav/.m4a) → расшифрованный текст.
  async function transcribeAudio(file) {
    const fd = new FormData();
    fd.append("file", file, file.name || "audio.ogg");

    if (mode() === "direct") {
      fd.append("model", "whisper-1");
      const resp = await fetch(OPENAI_API + "/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + directKey() },
        body: fd
      });
      const data = await readJson(resp);
      return data.text || "";
    }

    const data = await edgeRequest({
      method: "POST",
      headers: edgeHeaders(),
      body: fd
    });
    return data.text || "";
  }

  // Текст заказа → структура { client_name, client_comment, repeat_last_order, urgent, items[] }.
  async function parseOrder(text) {
    if (mode() === "direct") {
      const resp = await fetch(OPENAI_API + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + directKey(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text }
          ]
        })
      });
      const data = await readJson(resp);
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "{}";
      return safeJsonParse(content);
    }

    const data = await edgeRequest({
      method: "POST",
      headers: edgeHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "parse", text: text })
    });
    if (data.result) return data.result;
    throw new Error("Edge Function не вернула результат разбора.");
  }

  window.AI = {
    transcribeAudio: transcribeAudio,
    parseOrder: parseOrder,
    SYSTEM_PROMPT: SYSTEM_PROMPT
  };
})();
