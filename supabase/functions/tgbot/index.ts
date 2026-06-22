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
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.2/package/xlsx.mjs";
import { normalizeTranscript } from "./normalize.ts";
import { mergeStandardOrder, matchProduct, pickClient, MANAGER_NAMES } from "./order-logic.ts";

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

const CATALOG_LIMIT = 600;
// Каталог товаров клиента → отдельное system-сообщение для привязки названий.
// Дублирует логику из js/openai.js / openaiproxy (держать в синхроне).
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

// deno-lint-ignore no-explicit-any
async function parseOrder(text: string, catalog?: any): Promise<any> {
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }];
  const catMsg = catalogMessage(catalog);
  if (catMsg) messages.push({ role: "system", content: catMsg });
  messages.push({ role: "user", content: text });
  const r = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
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
      in_catalog: it && it.in_catalog === false ? false : true,
      article: it && it.article ? String(it.article) : null,
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
    const flags: string[] = [];
    if (it.qty == null || it.corrected || it.confidence === "low") flags.push("⚠️");
    if (it.in_catalog === false) flags.push("❗нет в каталоге");
    const warn = flags.length ? "  " + flags.join(" ") : "";
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

// Telegram-личность отправителя (msg.from / cb.from) для привязки в веб-кабинете.
// deno-lint-ignore no-explicit-any
function identityOf(from: any) {
  return {
    tg_username:   from && from.username   ? String(from.username)   : null,
    tg_first_name: from && from.first_name ? String(from.first_name) : null,
    tg_last_name:  from && from.last_name  ? String(from.last_name)  : null,
  };
}

// Best-effort: сохраняем @username / имя чата. Не критично — не должно ломать
// поток, если колонок ещё нет (миграция schema.sql не выполнена).
// deno-lint-ignore no-explicit-any
async function saveIdentity(chatId: number, from: any) {
  if (!from) return;
  try { await svc().from("telegram_links").update(identityOf(from)).eq("chat_id", chatId); }
  catch (_e) { /* колонок может не быть до миграции */ }
}

// Обновляет личность только при изменении — чтобы не писать на каждое сообщение.
// deno-lint-ignore no-explicit-any
async function touchIdentity(chatId: number, link: any, from: any) {
  if (!from) return;
  const id = identityOf(from);
  if (link.tg_username === id.tg_username &&
      link.tg_first_name === id.tg_first_name &&
      link.tg_last_name === id.tg_last_name) return;
  await saveIdentity(chatId, from);
}

// Отправка файла документом в Telegram (multipart).
async function tgDocument(chatId: number, filename: string, blob: Blob, caption: string, replyMarkup: unknown) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("document", blob, filename);
  if (caption) fd.append("caption", caption);
  if (replyMarkup) fd.append("reply_markup", JSON.stringify(replyMarkup));
  const r = await fetch(`${TG_API}/sendDocument`, { method: "POST", body: fd });
  return await r.json();
}

// deno-lint-ignore no-explicit-any
function buildXlsx(items: any[]): Uint8Array {
  // deno-lint-ignore no-explicit-any
  const rows: any[][] = [["№", "Код", "Наименование", "Количество", "Ед.изм.", "Цена", "Сумма"]];
  let total = 0;
  items.forEach((it, i) => {
    const sum = it.qty != null && it.price != null ? it.qty * it.price : "";
    if (typeof sum === "number") total += sum;
    rows.push([i + 1, it.article || "", it.name || "", it.qty == null ? "" : it.qty, it.unit || "", it.price == null ? "" : it.price, sum]);
  });
  rows.push(["", "", "Итого", "", "", "", total]);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 5 }, { wch: 10 }, { wch: 38 }, { wch: 12 }, { wch: 9 }, { wch: 12 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Заказ");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
}

// Готовит файл заказа в нужном формате → { filename, blob }.
// deno-lint-ignore no-explicit-any
function buildOrderFile(format: string, clientName: string, items: any[]): { filename: string; blob: Blob } {
  const base = "Заказ_" + String(clientName || "клиент").replace(/[^\p{L}\p{N}]+/gu, "_");
  if (format === "csv") {
    return { filename: base + ".csv", blob: new Blob(["﻿" + buildCsv(items)], { type: "text/csv" }) };
  }
  return {
    filename: base + ".xlsx",
    blob: new Blob([buildXlsx(items)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  };
}

function csvCell(v: unknown): string {
  const s = String(v == null ? "" : v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// deno-lint-ignore no-explicit-any
function buildCsv(items: any[]): string {
  const rows: string[][] = [["№", "Код", "Наименование", "Количество", "Ед.изм.", "Цена", "Сумма"]];
  let total = 0;
  items.forEach((it, i) => {
    const sum = it.qty != null && it.price != null ? it.qty * it.price : "";
    if (typeof sum === "number") total += sum;
    rows.push([String(i + 1), it.article || "", it.name || "", it.qty == null ? "" : String(it.qty),
      it.unit || "", it.price == null ? "" : String(it.price), sum === "" ? "" : String(sum)]);
  });
  rows.push(["", "", "Итого", "", "", "", String(total)]);
  return rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

// deno-lint-ignore no-explicit-any
function stdItem(it: any) {
  return {
    name: it && it.name ? String(it.name) : "",
    qty: it && it.qty != null && it.qty !== "" && !isNaN(Number(it.qty)) ? Number(it.qty) : null,
    unit: it && it.unit ? String(it.unit) : "шт",
    price: it && it.price != null && it.price !== "" && !isNaN(Number(it.price)) ? Number(it.price) : null,
    confidence: "high", confidence_score: 90, corrected: false, note: "",
  };
}

// deno-lint-ignore no-explicit-any
function summarizeChanges(changes: any[]): string {
  if (!changes || !changes.length) return "";
  const upd = changes.filter((c) => c.type === "updated").map((c) => `${c.name}: ${c.from ?? "?"}→${c.to ?? "?"}`);
  const rem = changes.filter((c) => c.type === "removed").map((c) => c.name);
  const parts: string[] = [];
  if (upd.length) parts.push("обновлено — " + upd.join(", "));
  if (rem.length) parts.push("убрано — " + rem.join(", "));
  return parts.length ? " (" + parts.join("; ") + ")" : "";
}

function likeContains(fragment: string): string {
  return "%" + String(fragment).replace(/([%_\\])/g, "\\$1") + "%";
}

// deno-lint-ignore no-explicit-any
async function processOrderText(chatId: number, link: any, rawText: string) {
  if (!rawText || !rawText.trim()) {
    await tg("sendMessage", { chat_id: chatId, text: "Не удалось распознать текст. Попробуйте ещё раз." });
    return;
  }
  const norm = normalizeTranscript(rawText);
  const supplier = link.user_id;
  // Каталог товаров поставщика — для привязки названий моделью и подстановки цен.
  const { data: products } = await svc().from("products").select("name, unit, price, article").eq("user_id", supplier);
  // deno-lint-ignore no-explicit-any
  const parsed = await parseOrder(norm.text, (products ?? []).map((p: any) => {
    // deno-lint-ignore no-explicit-any
    const e: any = { name: p.name };
    if (p.unit) e.unit = p.unit;
    if (p.article) e.article = p.article;
    return e;
  }));
  let items = normItems(parsed.items);

  let chosenName = parsed.client_name ? String(parsed.client_name) : "";
  // deno-lint-ignore no-explicit-any
  let dbClient: any = null;

  if (link.role === "customer" && link.client_name) {
    // Клиент фиксирован — это кафе, приславшее заказ (не доверяем имени из речи).
    chosenName = link.client_name;
    const { data } = await svc().from("clients").select("name, standard_order")
      .eq("user_id", supplier).ilike("name", likeContains(chosenName)).limit(1);
    if (data && data[0]) { dbClient = data[0]; chosenName = data[0].name; }
  } else {
    // Менеджер: определяем клиента среди кандидатов по базе клиентов поставщика.
    // deno-lint-ignore no-explicit-any
    const cands: any[] = [];
    if (Array.isArray(parsed.name_candidates)) {
      // deno-lint-ignore no-explicit-any
      parsed.name_candidates.forEach((c: any) => { if (c && c.name) cands.push({ name: String(c.name).trim(), greeting: c.greeting === true }); });
    }
    if (parsed.client_name && !cands.some((c) => c.name.toLowerCase() === String(parsed.client_name).toLowerCase())) {
      cands.unshift({ name: String(parsed.client_name).trim(), greeting: false });
    }
    if (cands.length) {
      // deno-lint-ignore no-explicit-any
      const checked: any[] = [];
      for (const c of cands) {
        const { data } = await svc().from("clients").select("name, standard_order")
          .eq("user_id", supplier).ilike("name", likeContains(c.name)).limit(1);
        const hit = data && data[0];
        checked.push({ name: c.name, greeting: c.greeting, inDb: !!hit, _db: hit || null });
      }
      const pick = pickClient(checked, MANAGER_NAMES);
      if (pick) {
        const row = checked.find((c) => c.name.toLowerCase() === pick.name.toLowerCase());
        dbClient = row ? row._db : null;
        chosenName = dbClient ? dbClient.name : pick.name;
      }
    }
  }

  // 2. «Как обычно» → слияние стандартного заказа клиента (без дублей).
  let note = "";
  if (parsed.repeat_last_order && dbClient && Array.isArray(dbClient.standard_order) && dbClient.standard_order.length) {
    const merged = mergeStandardOrder(dbClient.standard_order.map(stdItem), items);
    items = merged.items;
    note = `↩️ Подставлен стандартный заказ «${chosenName}»${summarizeChanges(merged.changes)}`;
  } else if (parsed.repeat_last_order && !dbClient) {
    note = "↩️ Просит «как обычно», но клиент не найден в базе — проверьте имя.";
  }

  // 3. Цены из каталога для позиций без цены (каталог уже загружен выше).
  if (products && products.length) {
    items.forEach((it) => {
      if (it.price == null) { const p = matchProduct(it.name, products, it.article ?? undefined); if (p && p.price != null) it.price = Number(p.price); }
    });
  }

  // 4. Сохраняем pending и шлём CSV-файл с кнопками.
  await svc().from("telegram_links").update({
    pending_order: { client_name: chosenName || null, items, source_text: norm.text },
  }).eq("chat_id", chatId);

  let caption = formatOrder({ ...parsed, client_name: chosenName }, items, norm);
  if (note) caption += "\n" + note;
  const file = buildOrderFile(link.file_format || "xlsx", chosenName, items);
  await tgDocument(chatId, file.filename, file.blob, caption.slice(0, 1000), {
    inline_keyboard: [[{ text: "✅ Сохранить", callback_data: "save" }, { text: "✖ Отмена", callback_data: "cancel" }]],
  });
}

// deno-lint-ignore no-explicit-any
function pendingSummary(pending: any): string {
  const items = Array.isArray(pending.items) ? pending.items : [];
  return items.map((it: any, i: number) => `${i + 1}. ${it.name} — ${it.qty == null ? "?" : it.qty} ${it.unit || ""}`).join("\n");
}

// Пересылает заказ клиента всем чатам-менеджерам этого поставщика (CSV + сводка).
// deno-lint-ignore no-explicit-any
async function forwardToManagers(supplier: string, pending: any): Promise<number> {
  const { data } = await svc().from("telegram_links").select("chat_id, file_format").eq("user_id", supplier).eq("role", "manager");
  if (!data || !data.length) return 0;
  const cafe = pending.client_name || "клиент";
  const caption = (`🆕 Новый заказ от «${cafe}»\n` + pendingSummary(pending)).slice(0, 1000);
  for (const m of data) {
    const file = buildOrderFile(m.file_format || "xlsx", cafe, pending.items || []);
    await tgDocument(m.chat_id, file.filename, file.blob, caption, null);
  }
  return data.length;
}

// deno-lint-ignore no-explicit-any
async function onCallback(cb: any) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const data = cb.data;
  const link = await getLink(chatId);
  await tg("answerCallbackQuery", { callback_query_id: cb.id });
  if (!link || !link.user_id) return;

  // Сообщение с заказом — это документ (CSV), поэтому правим не текст, а
  // только убираем кнопки; подтверждение шлём отдельным сообщением.
  const clearButtons = () =>
    tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });

  if (data === "cancel") {
    await svc().from("telegram_links").update({ pending_order: null }).eq("chat_id", chatId);
    await clearButtons();
    await tg("sendMessage", { chat_id: chatId, text: "Отменено.", reply_markup: kb(link) });
    return;
  }
  if (data === "save") {
    const pending = link.pending_order;
    if (!pending || !Array.isArray(pending.items) || !pending.items.length) {
      await clearButtons();
      await tg("sendMessage", { chat_id: chatId, text: "Нечего сохранять (заказ устарел). Пришлите заново." });
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
      await tg("sendMessage", { chat_id: chatId, text: "Ошибка сохранения: " + error.message });
      return;
    }
    await svc().from("telegram_links").update({ pending_order: null }).eq("chat_id", chatId);
    await clearButtons();
    if (link.role === "customer") {
      const n = await forwardToManagers(link.user_id, pending);
      await tg("sendMessage", { chat_id: chatId, reply_markup: kb(link),
        text: n ? "✅ Заказ отправлен поставщику. Спасибо!"
                : "✅ Заказ принят и сохранён. (Менеджер ещё не подключил Telegram.)" });
    } else {
      await tg("sendMessage", { chat_id: chatId, reply_markup: kb(link),
        text: "✅ Заказ сохранён. Откройте веб-кабинет, чтобы выгрузить Excel." });
    }
  }
}

// Постоянная клавиатура с основными действиями (менеджер).
function mainKeyboard() {
  return {
    keyboard: [["📦 Мои заказы", "👤 Мой аккаунт"], ["📄 Формат файла", "ℹ️ Помощь"], ["🚪 Выйти"]],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function customerKeyboard() {
  return { keyboard: [["ℹ️ Помощь"], ["🚪 Выйти"]], resize_keyboard: true, is_persistent: true };
}
// deno-lint-ignore no-explicit-any
function kb(link: any) { return link && link.role === "customer" ? customerKeyboard() : mainKeyboard(); }

// Текст кнопки/команды → действие.
function cmdOf(text: string): string | null {
  const t = (text || "").trim();
  if (t === "/start") return "start";
  if (t === "/logout" || t === "🚪 Выйти") return "logout";
  if (t === "/help" || t === "ℹ️ Помощь") return "help";
  if (t === "/account" || t === "/status" || t === "👤 Мой аккаунт") return "account";
  if (t === "/orders" || t === "📦 Мои заказы") return "orders";
  if (t === "/format" || t === "📄 Формат файла") return "format";
  return null;
}

async function setCommands() {
  await tg("setMyCommands", { commands: [
    { command: "start", description: "Войти / меню" },
    { command: "orders", description: "Мои последние заказы" },
    { command: "account", description: "Мой тариф" },
    { command: "format", description: "Формат файла: Excel/CSV" },
    { command: "logout", description: "Выйти из аккаунта" },
    { command: "help", description: "Помощь" },
  ] });
}

// deno-lint-ignore no-explicit-any
async function doFormat(chatId: number, link: any) {
  const next = link.file_format === "csv" ? "xlsx" : "csv";
  await svc().from("telegram_links").update({ file_format: next }).eq("chat_id", chatId);
  const label = next === "csv" ? "CSV" : "Excel (.xlsx)";
  await tg("sendMessage", { chat_id: chatId, text: `Формат файла заказов: ${label}. Нажмите ещё раз, чтобы переключить.`, reply_markup: mainKeyboard() });
}

async function doLogout(chatId: number) {
  await svc().from("telegram_links").delete().eq("chat_id", chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Вы вышли из аккаунта. Пришлите ключ доступа, чтобы войти снова.",
    reply_markup: { remove_keyboard: true },
  });
}

// deno-lint-ignore no-explicit-any
async function doHelp(chatId: number, link: any) {
  const text = link && link.role === "customer"
    ? "Присылайте заказ голосом или текстом — я разберу его и передам поставщику (подтвердите кнопкой ✅).\n🚪 Выйти — отвязать чат."
    : "Пришлите голосовое сообщение или текст заказа — я разберу его в позиции и предложу сохранить (кнопки ✅/✖).\n\nМеню:\n📦 Мои заказы — последние 5\n👤 Мой аккаунт — тариф и статус\n🚪 Выйти — отвязать чат";
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: kb(link) });
}

// deno-lint-ignore no-explicit-any
async function doAccount(chatId: number, link: any) {
  const sub = await svc().from("subscriptions").select("plan,status").eq("user_id", link.user_id).maybeSingle();
  const plan = sub.data && sub.data.plan === "pro" ? "Pro" : "Basic";
  const st = sub.data && sub.data.status === "active" ? "активна" : (sub.data ? "истекла" : "—");
  await tg("sendMessage", {
    chat_id: chatId,
    text: `👤 ${link.company_name}\nТариф: ${plan}\nПодписка: ${st}`,
    reply_markup: mainKeyboard(),
  });
}

// deno-lint-ignore no-explicit-any
async function doOrders(chatId: number, link: any) {
  const { data } = await svc().from("orders")
    .select("created_at, client_name, items").eq("user_id", link.user_id)
    .order("created_at", { ascending: false }).limit(5);
  if (!data || !data.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Заказов пока нет.", reply_markup: mainKeyboard() });
    return;
  }
  const lines = data.map((o: { created_at: string; client_name: string | null; items: unknown }, i: number) => {
    const d = new Date(o.created_at).toLocaleDateString("ru-RU");
    const n = Array.isArray(o.items) ? o.items.length : 0;
    return `${i + 1}. ${d} — ${o.client_name || "—"} — ${n} поз.`;
  });
  await tg("sendMessage", { chat_id: chatId, text: "📦 Последние заказы:\n" + lines.join("\n"), reply_markup: mainKeyboard() });
}

// deno-lint-ignore no-explicit-any
async function handle(update: any) {
  if (update.callback_query) return await onCallback(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const link = await getLink(chatId);

  // Поддерживаем @username / имя чата в актуальном виде (для привязки в вебе).
  if (link && link.user_id) await touchIdentity(chatId, link, msg.from);

  // ── Ссылка-приглашение клиента: /start <customer_code> ──
  const startPayload = text.startsWith("/start ") ? text.slice(7).trim() : "";
  if (startPayload) {
    const acct = await svc().from("clients_accounts")
      .select("user_id, company_name, status").eq("customer_code", startPayload).maybeSingle();
    if (acct.data && acct.data.status === "active") {
      await svc().from("telegram_links").upsert({
        chat_id: chatId, user_id: acct.data.user_id, company_name: acct.data.company_name,
        role: "customer", client_name: null, pending_order: null,
      }, { onConflict: "chat_id" });
      await saveIdentity(chatId, msg.from);
      await tg("sendMessage", { chat_id: chatId,
        text: `Вы подключаетесь к поставщику «${acct.data.company_name}».\nНапишите название вашего заведения (например: Кафе Лагман).`,
        reply_markup: { remove_keyboard: true } });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: "Ссылка-приглашение недействительна. Обратитесь к поставщику." });
    return;
  }

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
      chat_id: chatId, user_id: acct.data.user_id, company_name: acct.data.company_name,
      role: "manager", client_name: null, pending_order: null,
    }, { onConflict: "chat_id" });
    await saveIdentity(chatId, msg.from);
    await setCommands();
    await tg("sendMessage", { chat_id: chatId, text:
      `Готово ✅ Чат привязан к «${acct.data.company_name}».\n\nПрисылайте голосовое сообщение или текст заказа — я разберу его в позиции.`,
      reply_markup: mainKeyboard() });
    return;
  }

  // ── Клиент только что подключился по ссылке: ждём название заведения ──
  if (link.role === "customer" && !link.client_name) {
    if (text && !text.startsWith("/")) {
      const name = text.trim();
      const existing = await svc().from("clients").select("id").eq("user_id", link.user_id).ilike("name", likeContains(name)).limit(1);
      if (!existing.data || !existing.data.length) {
        await svc().from("clients").insert({ user_id: link.user_id, name });
      }
      await svc().from("telegram_links").update({ client_name: name }).eq("chat_id", chatId);
      await tg("sendMessage", { chat_id: chatId,
        text: `Готово, «${name}»! Присылайте заказ голосом или текстом — я передам его поставщику.`,
        reply_markup: customerKeyboard() });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: "Напишите, пожалуйста, название вашего заведения текстом." });
    return;
  }

  // ── Привязан ──
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
  switch (cmdOf(text)) {
    case "start":
      await setCommands();
      await tg("sendMessage", { chat_id: chatId, text:
        `Вы вошли как «${link.company_name}». Пришлите голосовое или текст заказа.`, reply_markup: kb(link) });
      return;
    case "logout": await doLogout(chatId); return;
    case "help": await doHelp(chatId, link); return;
    case "account": if (link.role !== "customer") { await doAccount(chatId, link); return; } break;
    case "orders": if (link.role !== "customer") { await doOrders(chatId, link); return; } break;
    case "format": if (link.role !== "customer") { await doFormat(chatId, link); return; } break;
  }
  if (text && !text.startsWith("/")) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    await processOrderText(chatId, link, text);
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: "Пришлите голосовое сообщение или текст заказа.", reply_markup: kb(link) });
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
