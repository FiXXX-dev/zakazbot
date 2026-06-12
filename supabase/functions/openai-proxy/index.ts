// Supabase Edge Function: openai-proxy
//
// Прокси к OpenAI: ключ хранится в секретах Supabase и НЕ попадает в браузер.
//
// Деплой:  supabase functions deploy openai-proxy
// Секрет:  supabase secrets set OPENAI_API_KEY=sk-...
//
// Запросы:
//   POST multipart/form-data { file }              → { text }   (Whisper)
//   POST application/json { action: "parse", text } → { result } (GPT-4o-mini)
//
// Системный промпт продублирован в js/openai.js (режим "direct") —
// изменения вносить в оба файла синхронно.

const SYSTEM_PROMPT = `Ты — система распознавания заказов для поставщика HoReCa.
Клиент диктует заказ на русском или узбекском языке.
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
      "unit": "шт/уп/кг/л/пар/рул/пач",
      "confidence": "high/medium/low",
      "note": "пометка если что-то неясно"
    }
  ]
}
Правила:
- confidence=low если название товара непонятно или количество не указано
- Узбекские слова: dona=штук, juft=пар, qop=мешок
- Не придумывай количество если не сказано — ставь null
- "как обычно" — repeat_last_order=true`;

const OPENAI_API = "https://api.openai.com/v1";

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
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
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
