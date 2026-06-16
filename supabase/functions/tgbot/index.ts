// Supabase Edge Function: tgbot — Telegram webhook приёма заказов.
//
// Поток: голос/текст → Whisper → нормализация → GPT → подтверждение кнопкой →
// сохранение в orders под привязанным аккаунтом. Привязка чата к аккаунту — по
// ACCESS_KEY (/start → прислать ключ). Старт «менеджер-оператор»; позже сюда же
// добавится маршрутизация для клиентов напрямую.
//
// Секреты: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (опц.), OPENAI_API_KEY.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY подставляются автоматически.
// Webhook: setWebhook на URL функции с secret_token = TELEGRAM_WEBHOOK_SECRET.
//
// SYSTEM_PROMPT продублирован в js/openai.js и openaiproxy/index.ts —
// изменения вносить во все три синхронно.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeTranscript } from "./normalize.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENAI_API = "https://api.openai.com/v1";
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const WHISPER_PROMPT =
  "Заказ товаров на узбекском языке. Числа: ikki ta, ikki yuz ta, besh ta, o'n ta, " +
  "yigirma ta, ellik ta, yuz ta, ming ta, ikki ming ta. Товары: plastik stakan, " +
  "plastik vilka, qoshiq, idish, paket, qop, korobka. Самоисправления: yo'q, yo'q yo'q, emas.";

const SYSTEM_PROMPT = `Ты — система распознавания заказов для поставщика HoReCa.
Клиент диктует заказ на русском, узбекском или смешанном русско-узбекском языке.
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
      "note": "пометка если что-то неясно"
    }
  ]
}
Правила:
- Название заведения (кафе, ресторан, магазин и т.д.) или имя клиента рядом со словом «это» — это client_name, а НЕ товар.
- ИМЕНА. В name_candidates перечисли ВСЕ имена людей из текста; ставь greeting=true, если это приветственное обращение («Добрый день, Имя», «Салом, Имя», «Здравствуйте, Имя»). В client_name укажи того, кто РАЗМЕЩАЕТ заказ, а не того, кого просто поприветствовали; не выбирай имя только потому, что оно первое или стоит сразу после приветствия. Если не уверен — оставь client_name пустым, но name_candidates всё равно заполни.
- В items только то, что заказывают: продукты, упаковка, посуда и т.д. Не добавляй в items название заведения или имя клиента.
- САМОИСПРАВЛЕНИЯ И УТОЧНЕНИЯ. Клиент часто называет одно число, потом говорит «ээ», «нет», «йук», «yo'q», «ne», «ya'ni» и называет другое число — это значит он ИСПРАВЛЯЕТ себя. Всегда бери ПОСЛЕДНЕЕ названное число, не первое. Пример: «2 штуки... ээ нет 200 штук» → qty=200. Пример: «вилок столько же» → то же количество что у предыдущего товара. Для таких позиций ставь corrected=true.
- ПОВТОРЫ. Если один и тот же товар упомянут несколько раз — используй последнюю, уточнённую версию (количество и единицу), не дублируй позицию.
- Узбекские единицы: dona=шт, ta=шт, juft=пар, qop=мешок, korobka=коробка, upakovka=упаковка.
- confidence_score (0–100) — насколько уверенно распознана позиция. Понижай его, если: количество не указано, название товара неясно, было самоисправление. Согласуй: confidence="low" при score<55, "medium" при 55–79, "high" при ≥80.
- Не придумывай количество если не сказано — ставь qty=null и понижай confidence_score.
- ПРАВИЛО МОДИФИКАЦИИ: Клиент может ссылаться на прошлый или стандартный заказ разными способами: «как обычно», «как вчера», «как всегда», «повтори прошлый», «помнишь прошлый заказ», «на прошлой неделе брали», «стандартный наш», «odatdagidek» и т.д. Во всех этих случаях ставь repeat_last_order=true — за основу берётся стандартный заказ клиента из базы.
Если вместе с этим клиент указывает изменения — найди нужную позицию в стандартном заказе и ИЗМЕНИ её количество или убери её. НИКОГДА не добавляй дубль — если товар уже есть в списке (даже под похожим названием), только обновляй его, не создавай новую строку.
Если клиент убирает товар («убери», «не нужно», «больше не берём») — верни эту позицию с qty=0.`;

function svc() {
  return createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// deno-lint-ignore no-explicit-any
async function tg(method: string, payload: any): Promise<any> {
  const r = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text); } catch { /* ниже */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  return null;
}

async function transcribe(fileId: string): Promise<string> {
  const f = await tg("getFile", { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path) return "";
  const fileResp = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${path}`);
  const blob = await fileResp.blob();
  const fd = new FormData();
  fd.append("file", blob, "audio.ogg");
  fd.append("model", "whisper-1");
  fd.append("prompt", WHISPER_PROMPT);
  const r = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: fd,
  });
  const d = await r.json();
  return d?.text ?? "";
}

// deno-lint-ignore no-explicit-any
async function parseOrder(text: string): Promise<any> {
  const r = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: text }],
    }),
  });
  const d = await r.json();
  const content = d?.choices?.[0]?.message?.content ?? "{}";
  return safeJsonParse(content) ?? {};
}

// deno-lint-ignore no-explicit-any
function normItems(items: any): any[] {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    const qtyN = it && it.qty != null && it.qty !== "" && !isNaN(Number(it.qty)) ? Number(it.qty) : null;
    return {
      name: it && it.name ? String(it.name) : "",
      qty: qtyN,
      unit: it && it.unit ? String(it.unit) : "шт",
      price: null,
      confidence: it && (it.confidence === "low" || it.confidence === "medium") ? it.confidence : "high",
      confidence_score: typeof (it && it.confidence_score) === "number" ? it.confidence_score : null,
      corrected: !!(it && it.corrected),
      note: it && it.note ? String(it.note) : "",
    };
  }).filter((x) => x.name.trim() !== "");
}

// deno-lint-ignore no-explicit-any
function formatOrder(parsed: any, items: any[], norm: any): string {
  const lines: string[] = [];
  lines.push("📋 Распознанный заказ");
  if (parsed.client_name) lines.push(`Клиент: ${parsed.client_name}`);
  if (parsed.urgent) lines.push("🔴 Срочный");
  if (parsed.repeat_last_order) lines.push("↩️ Просит «как обычно» (стандартный заказ подставьте в системе)");
  lines.push("");
  items.forEach((it, i) => {
    const q = it.qty == null ? "?" : it.qty;
    const warn = it.qty == null || it.corrected || it.confidence === "low" ? "  ⚠️" : "";
    lines.push(`${i + 1}. ${it.name} — ${q} ${it.unit}${warn}`);
  });
  if (!items.length) lines.push("позиции не распознаны");
  if (norm.hadSelfCorrection) lines.push(`\n⚠️ Самоисправление (${norm.selfCorrections.join(", ")}) — проверьте количества.`);
  if (parsed.client_comment) lines.push(`\n💬 ${parsed.client_comment}`);
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
async function getLink(chatId: number): Promise<any> {
  const { data } = await svc().from("telegram_links").select("*").eq("chat_id", chatId).maybeSingle();
  return data;
}

async function processOrderText(chatId: number, link: { user_id: string }, rawText: string) {
  if (!rawText || !rawText.trim()) {
    await tg("sendMessage", { chat_id: chatId, text: "Не удалось распознать текст. Попробуйте ещё раз." });
    return;
  }
  const norm = normalizeTranscript(rawText);
  const parsed = await parseOrder(norm.text);
  const items = normItems(parsed.items);

  await svc().from("telegram_links").update({
    pending_order: { client_name: parsed.client_name || null, items, source_text: norm.text },
  }).eq("chat_id", chatId);

  await tg("sendMessage", {
    chat_id: chatId,
    text: formatOrder(parsed, items, norm),
    reply_markup: { inline_keyboard: [[
      { text: "✅ Сохранить", callback_data: "save" },
      { text: "✖ Отмена", callback_data: "cancel" },
    ]] },
  });
}

// deno-lint-ignore no-explicit-any
async function onCallback(cb: any) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data;
  const link = await getLink(chatId);
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (!link || !link.user_id) return;

  if (data === "cancel") {
    await svc().from("telegram_links").update({ pending_order: null }).eq("chat_id", chatId);
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Отменено." });
    return;
  }
  if (data === "save") {
    const pending = link.pending_order;
    if (!pending || !Array.isArray(pending.items) || !pending.items.length) {
      await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Нечего сохранять." });
      return;
    }
    const { error } = await svc().from("orders").insert({
      user_id: link.user_id,
      client_name: pending.client_name || "Без имени",
      status: "new",
      items: pending.items,
      source_text: pending.source_text || null,
    });
    if (error) {
      await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Ошибка сохранения: " + error.message });
      return;
    }
    await svc().from("telegram_links").update({ pending_order: null }).eq("chat_id", chatId);
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "✅ Заказ сохранён. Откройте веб-кабинет, чтобы выгрузить Excel." });
  }
}

// deno-lint-ignore no-explicit-any
async function handle(update: any) {
  if (update.callback_query) return await onCallback(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const link = await getLink(chatId);

  // ── Не привязан: ждём ключ доступа ──
  if (!link || !link.user_id) {
    if (text === "/start" || !text) {
      await tg("sendMessage", { chat_id: chatId, text:
        "Привет! Это ZakazBot. Пришлите ваш *ключ доступа* (его выдаёт поставщик), чтобы привязать чат.",
        parse_mode: "Markdown" });
      return;
    }
    // любое текстовое сообщение трактуем как ключ
    const acct = await svc().from("clients_accounts")
      .select("user_id, company_name, status").eq("access_key", text).maybeSingle();
    if (!acct.data) {
      await tg("sendMessage", { chat_id: chatId, text: "Неверный ключ доступа. Попробуйте ещё раз." });
      return;
    }
    if (acct.data.status !== "active") {
      await tg("sendMessage", { chat_id: chatId, text: "Доступ отключён. Обратитесь к поставщику." });
      return;
    }
    await svc().from("telegram_links").upsert({
      chat_id: chatId, user_id: acct.data.user_id, company_name: acct.data.company_name, pending_order: null,
    }, { onConflict: "chat_id" });
    await tg("sendMessage", { chat_id: chatId, text:
      `Готово ✅ Чат привязан к «${acct.data.company_name}».\n\nПрисылайте голосовое сообщение или текст заказа — я разберу его в позиции.` });
    return;
  }

  // ── Привязан ──
  if (text === "/start") {
    await tg("sendMessage", { chat_id: chatId, text:
      `Вы вошли как «${link.company_name}». Пришлите голосовое или текст заказа.` });
    return;
  }
  if (msg.voice || msg.audio) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    const fileId = (msg.voice || msg.audio).file_id;
    const rawText = await transcribe(fileId);
    if (rawText && rawText.trim()) {
      await tg("sendMessage", { chat_id: chatId, text: "🎙️ Расшифровка: " + rawText });
    }
    await processOrderText(chatId, link, rawText);
    return;
  }
  if (text && !text.startsWith("/")) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    await processOrderText(chatId, link, text);
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: "Пришлите голосовое сообщение или текст заказа." });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("ok");
  if (WEBHOOK_SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 401 });
  }
  let update;
  try { update = await req.json(); } catch { return new Response("ok"); }
  try { await handle(update); } catch (e) { console.error("tgbot error:", e); }
  // Всегда 200 — иначе Telegram будет ретраить апдейт.
  return new Response("ok");
});
