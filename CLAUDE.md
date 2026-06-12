# CLAUDE.md

Руководство по работе с этим репозиторием.

## О проекте

ZakazBot — MVP приёма заказов для поставщика HoReCa. Менеджер загружает
голосовое сообщение или текст клиента → Whisper расшифровывает → GPT-4o-mini
выделяет позиции → менеджер правит таблицу → Excel для 1С + сохранение в Supabase.

Чистый HTML/CSS/JS без сборки и фреймворков. Деплой — статикой (GitHub Pages).
Библиотеки (supabase-js, SheetJS) подключаются с CDN, глобальными объектами.

## Запуск и проверка

- Локальный сервер: `npx serve .` (подойдёт любой статический сервер)
- Сборки, тестов и линтера нет — проверять страницы в браузере
- Схема БД: выполнить `sql/schema.sql` в SQL Editor Supabase
- Edge Function: `supabase functions deploy openai-proxy`,
  ключ: `supabase secrets set OPENAI_API_KEY=sk-...`

## Структура

| Файл | Назначение |
|---|---|
| `index.html` + `js/orders.js` | Входящие заказы: поиск, фильтры (статус, сегодня/всё время), смена статуса, Excel, удаление |
| `new-order.html` + `js/new-order.js` | Распознавание аудио/текста, редактируемая таблица позиций, Excel, сохранение |
| `clients.html` + `js/clients.js` | Клиенты: поиск, история заказов, стандартный заказ («как обычно») |
| `js/supabase-client.js` | Создаёт `window.sb` (клиент Supabase) |
| `js/openai.js` | Whisper + GPT-4o-mini, режимы edge/direct, системный промпт |
| `js/excel.js` | `window.ExcelUtils.downloadOrderExcel(order)` — выгрузка XLSX |
| `supabase/functions/openai-proxy/index.ts` | Edge Function — прокси к OpenAI |
| `sql/schema.sql` | Таблицы `orders`, `clients` + RLS-политики |
| `config.js` | Конфигурация (хранится в репозитории: только публичные значения, ключ OpenAI — никогда) |

## Критические правила

1. **Клиент Supabase.** `window.supabase` — это UMD-библиотека с CDN,
   `window.sb` — клиент, созданный в `js/supabase-client.js`.
   Обращения к БД ТОЛЬКО через `window.sb.from(...)`.
   Никогда не писать `window.supabase.from(...)`.

2. **Ключ OpenAI не попадает в браузер.** `OPENAI_MODE: "edge"` по умолчанию —
   все вызовы идут через Edge Function `openai-proxy`, ключ лежит в секретах
   Supabase. `config.js` хранится в репозитории (нужен GitHub Pages) и содержит
   только публичные значения: URL, anon-ключ Supabase, `OPENAI_API_KEY` всегда
   пустой. Режим `"direct"` (ключ вписан в config.js) — только локальный тест,
   такой файл НЕ коммитить.

3. **Системный промпт продублирован** в `js/openai.js` (direct) и
   `supabase/functions/openai-proxy/index.ts` (edge).
   Любые изменения промпта вносить в ОБА файла синхронно.

4. **Таблица позиций (new-order) не перерисовывается при вводе.**
   Обработчики `input` обновляют только модель (`items`), ячейку «Сумма» и
   подсветку строки — иначе сбрасывается фокус с инпута. Полная перерисовка
   `tbody` допустима только после распознавания; добавление/удаление строк —
   точечные `appendChild` / `tr.remove()` + перенумерация.

5. **Подсветка уточнений.** Жёлтым (`tr.row-warn`: фон `#fff7d6`,
   рамка `#f0d775`) выделяются строки с `confidence === "low"` или
   `qty == null`. Правка названия менеджером снимает `low`.

## Данные

```
orders:  id uuid, created_at, client_name, client_phone,
         status ('new'|'processing'|'ready'), items jsonb, source_text, excel_url
clients: id uuid, created_at, name, phone, standard_order jsonb, notes
```

Элемент `items` / `standard_order`:
`{ name, qty: number|null, unit, price: number|null, confidence: "high"|"medium"|"low", note }`

Заказы связаны с клиентом по `client_name` (текст, без FK) — MVP-упрощение.

## Дизайн

Белый фон, тёмно-серый текст, акцент `#0d7d6f`, sticky-шапка с навигацией,
адаптив до мобильных. Все стили в `css/style.css`, палитра в `:root`.
Excel: колонки `№ | Наименование | Количество | Ед.изм. | Цена | Сумма`,
имя файла `Заказ_[клиент]_[дата].xlsx`.
