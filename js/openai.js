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
Клиент диктует заказ на русском, узбекском, смешанном русско-узбекском или другом языке.
Текст уже прошёл предварительную нормализацию (числительные приведены к цифрам).
Извлеки список товаров и верни ТОЛЬКО валидный JSON:
{
  "client_name": "имя клиента-заказчика если есть",
  "name_candidates": [ { "name": "имя человека", "greeting": true/false } ],
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
      "in_catalog": true/false,
      "article": "код товара если передан в каталоге",
      "note": "пометка если что-то неясно"
    }
  ]
}
Правила:
- Название заведения (кафе, ресторан, магазин и т.д.) или имя клиента рядом со словом «это» — это client_name, а НЕ товар.
- ИМЕНА. В name_candidates перечисли ВСЕ имена людей из текста; ставь greeting=true, если это приветственное обращение («Добрый день, Имя», «Салом, Имя», «Здравствуйте, Имя»). В client_name укажи того, кто РАЗМЕЩАЕТ заказ, а не того, кого просто поприветствовали; не выбирай имя только потому, что оно первое или стоит сразу после приветствия. Если не уверен — оставь client_name пустым, но name_candidates всё равно заполни.
- В items только то, что заказывают: продукты, упаковка, посуда и т.д. Не добавляй в items название заведения или имя клиента.
- САМОИСПРАВЛЕНИЯ И УТОЧНЕНИЯ. Клиент часто называет одно число, потом говорит «ээ», «нет», «йук», «yo'q», «ne», «ya'ni» и называет другое число — это значит он ИСПРАВЛЯЕТ себя. Всегда бери ПОСЛЕДНЕЕ названное число, не первое. Пример: «2 штуки... ээ нет 200 штук» → qty=200. Пример: «вилок столько же» → то же количество что у предыдущего товара. Для таких позиций ставь corrected=true.
- ПОВТОРЫ И СЛОВОФОРМЫ. Считай разные формы одного товара одним и тем же (стакан/стаканы/стаканов, пластиковый/пластиковая/пластик — это ОДИН товар) и НЕ создавай для него отдельные строки. Если товар сначала назван без количества, а число прозвучало позже («ещё стаканы… а стакан 200») — присвой это количество этому товару. Если товар упомянут несколько раз — одна строка с последним названным количеством.
- Узбекские единицы: dona=шт, ta=шт, juft=пар, qop=мешок, korobka=коробка, upakovka=упаковка.
- confidence_score (0–100) — насколько уверенно распознана позиция. Понижай его, если: количество не указано, название товара неясно, было самоисправление. Согласуй: confidence="low" при score<55, "medium" при 55–79, "high" при ≥80.
- Не придумывай количество если не сказано — ставь qty=null и понижай confidence_score.
- ПРАВИЛО МОДИФИКАЦИИ: Клиент может ссылаться на прошлый или стандартный заказ разными способами: «как обычно», «как вчера», «как всегда», «повтори прошлый», «помнишь прошлый заказ», «на прошлой неделе брали», «стандартный наш», «odatdagidek» и т.д. Во всех этих случаях ставь repeat_last_order=true — за основу берётся стандартный заказ клиента из базы.
Если вместе с этим клиент указывает изменения — найди нужную позицию в стандартном заказе и ИЗМЕНИ её количество или убери её. НИКОГДА не добавляй дубль — если товар уже есть в списке (даже под похожим названием), только обновляй его, не создавай новую строку.
Если клиент убирает товар («убери», «не нужно», «больше не берём») — верни эту позицию с qty=0.
- КАТАЛОГ ТОВАРОВ. Если отдельным системным сообщением передан КАТАЛОГ доступных товаров — сопоставляй каждую позицию строго с ним:
  • поле "name" пиши ТОЧНО как в каталоге (буква в букву), даже если клиент сказал на другом языке, сократил или ошибся; один товар на разных языках («стакан», «stakan», «cup», «杯子») → одно и то же каталожное название;
  • уверенно сопоставил — "in_catalog": true; в каталоге нет подходящего товара — НЕ выдумывай каталожное имя и НЕ выбрасывай позицию: оставь название как сказал клиент, "in_catalog": false, "confidence":"low", note "нет в каталоге";
  • соответствие неоднозначно (несколько похожих) — выбери наиболее вероятный, "in_catalog": true, "confidence":"low";
  • единицу для сопоставленного товара бери из каталога, если она там указана;
  • если в каталоге у товара есть поле "article" — верни его точно в поле "article" позиции.
Если каталог НЕ передан — ставь "in_catalog": true для всех распознанных позиций и работай как обычно.`;

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

  // Каталог товаров клиента → отдельное system-сообщение для привязки названий
  // (ограничиваем размер, чтобы не раздувать промпт). Дублируется в openaiproxy.
  const CATALOG_LIMIT = 600;
  function catalogMessage(catalog) {
    if (!Array.isArray(catalog) || !catalog.length) return null;
    const list = [];
    for (let i = 0; i < catalog.length && list.length < CATALOG_LIMIT; i++) {
      const c = catalog[i];
      const name = c && c.name ? String(c.name).trim() : "";
      if (!name) continue;
      const entry = { name: name };
      if (c && c.unit) entry.unit = String(c.unit);
      if (c && c.article) entry.article = String(c.article);
      list.push(entry);
    }
    if (!list.length) return null;
    return 'КАТАЛОГ ТОВАРОВ (сопоставляй строго с этими названиями; "name" в ответе — точно как здесь; если у товара есть "article" — верни его в "article" позиции):\n' + JSON.stringify(list);
  }

  // Текст заказа → структура { client_name, client_comment, repeat_last_order, urgent, items[] }.
  // catalog (необязательно) — массив { name, unit } товаров клиента для привязки названий.
  async function parseOrder(text, catalog) {
    if (mode() === "direct") {
      const messages = [{ role: "system", content: SYSTEM_PROMPT }];
      const catMsg = catalogMessage(catalog);
      if (catMsg) messages.push({ role: "system", content: catMsg });
      messages.push({ role: "user", content: text });
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
          messages: messages
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
      body: JSON.stringify({ action: "parse", text: text, catalog: Array.isArray(catalog) ? catalog : [] })
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
