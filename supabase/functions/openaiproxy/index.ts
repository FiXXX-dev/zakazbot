// Supabase Edge Function: openaiproxy
//
// Прокси к OpenAI: ключ хранится в секретах Supabase и НЕ попадает в браузер.
//
// Деплой:  supabase functions deploy openaiproxy
// Секрет:  supabase secrets set OPENAI_API_KEY=sk-...
//
// Запросы:
//   POST multipart/form-data { file }              → { text }   (Whisper)
//   POST application/json { action: "parse", text } → { result } (GPT-4o-mini)
//
// Системный промпт продублирован в js/openai.js (режим "direct") —
// изменения вносить в оба файла синхронно.

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
const CATALOG_LIMIT = 600;

// Каталог товаров клиента → отдельное system-сообщение для привязки названий.
// Дублирует логику из js/openai.js (держать в синхроне).
// deno-lint-ignore no-explicit-any
function catalogMessage(catalog: any): string | null {
  if (!Array.isArray(catalog) || !catalog.length) return null;
  const list: Array<Record<string, string>> = [];
  for (let i = 0; i < catalog.length && list.length < CATALOG_LIMIT; i++) {
    const c = catalog[i];
    const name = c && c.name ? String(c.name).trim() : "";
    if (!name) continue;
    const entry: Record<string, string> = { name };
    if (c && c.unit) entry.unit = String(c.unit);
    if (c && c.article) entry.article = String(c.article);
    list.push(entry);
  }
  if (!list.length) return null;
  return 'КАТАЛОГ ТОВАРОВ (сопоставляй строго с этими названиями; "name" в ответе — точно как здесь; если у товара есть "article" — верни его в "article" позиции):\n' + JSON.stringify(list);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Модель могла обернуть JSON в текст — пробуем вытащить объект.
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // Невалидный JSON.
    }
  }
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Используйте POST" }, 405);
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return json(
      { error: "Секрет OPENAI_API_KEY не задан: supabase secrets set OPENAI_API_KEY=sk-..." },
      500,
    );
  }

  try {
    const contentType = req.headers.get("content-type") ?? "";

    // Аудио → Whisper
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return json({ error: "Поле file (аудиофайл) обязательно" }, 400);
      }

      const upstream = new FormData();
      upstream.append("file", file, file.name || "audio.ogg");
      upstream.append("model", "whisper-1");
      // prompt смещает распознавание к узбекской торговой лексике/числам.
      // language НЕ задаём: OpenAI отклоняет код "uz" ("Language 'uz' is not
      // supported"), а автоопределение корректно берёт и узбекскую, и смешанную
      // русско-узбекскую речь. Подсказка ниже помогает с узбекскими словами.
      upstream.append("prompt", "Заказ товаров на узбекском языке. Числа: ikki ta, ikki yuz ta, besh ta, o'n ta, yigirma ta, ellik ta, yuz ta, ming ta, ikki ming ta. Товары: plastik stakan, plastik vilka, qoshiq, idish, paket, qop, korobka. Самоисправления: yo'q, yo'q yo'q, emas.");

      const resp = await fetch(`${OPENAI_API}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: upstream,
      });
      const data = await resp.json();
      if (!resp.ok) {
        return json({ error: data?.error?.message ?? "Ошибка Whisper" }, resp.status);
      }
      return json({ text: data.text ?? "" });
    }

    // Текст → GPT-4o-mini
    const body = await req.json();
    if (body?.action === "parse") {
      const text = String(body.text ?? "").trim();
      if (!text) {
        return json({ error: "Поле text обязательно" }, 400);
      }

      const messages: Array<{ role: string; content: string }> = [{ role: "system", content: SYSTEM_PROMPT }];
      const catMsg = catalogMessage(body.catalog);
      if (catMsg) messages.push({ role: "system", content: catMsg });
      messages.push({ role: "user", content: text });

      const resp = await fetch(`${OPENAI_API}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          messages,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return json({ error: data?.error?.message ?? "Ошибка OpenAI" }, resp.status);
      }

      const content = data?.choices?.[0]?.message?.content ?? "";
      const result = safeJsonParse(content);
      if (!result) {
        return json({ error: "Модель вернула невалидный JSON", raw: content }, 502);
      }
      return json({ result });
    }

    return json({ error: 'Неизвестное действие. Ожидается { "action": "parse", "text": "..." }' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
