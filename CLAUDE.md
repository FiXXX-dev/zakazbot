# CLAUDE.md

Руководство по работе с этим репозиторием.

## О проекте

ZakazBot — MVP приёма заказов для поставщика HoReCa. Менеджер загружает
голосовое сообщение или текст клиента → Whisper расшифровывает →
нормализация (узб./рус. числительные, исправления, самоисправления) →
GPT-4o-mini выделяет позиции → менеджер правит таблицу → Excel для 1С +
сохранение в Supabase. Распознаёт русскую, узбекскую и смешанную речь.

Чистый HTML/CSS/JS без сборки и фреймворков. Деплой — статикой (GitHub Pages).
Библиотеки (supabase-js, SheetJS) подключаются с CDN, глобальными объектами.

## Запуск и проверка

- Локальный сервер: `npx serve .` (подойдёт любой статический сервер)
- Сборки и линтера нет — проверять страницы в браузере
- Юнит-тесты логики (без браузера): `node tests/client-detect.test.js`
- Схема БД: выполнить `sql/schema.sql` в SQL Editor Supabase
- Edge Function: `supabase functions deploy openaiproxy`,
  ключ: `supabase secrets set OPENAI_API_KEY=sk-...`

## Структура

| Файл | Назначение |
|---|---|
| `index.html` + `js/orders.js` | Входящие заказы: поиск, фильтры (статус, сегодня/всё время), смена статуса, Excel, удаление |
| `new-order.html` + `js/new-order.js` | Распознавание аудио/текста, редактируемая таблица позиций, Excel, сохранение |
| `clients.html` + `js/clients.js` | Клиенты: поиск, история заказов, стандартный заказ («как обычно») |
| `admin.html` + `js/admin.js` | Админ: импорт товаров и клиентов из .csv/.xlsx (SheetJS) в `products` / `clients` |
| `js/supabase-client.js` | Создаёт `window.sb` (клиент Supabase) |
| `js/dictionary.js` | `window.ZakazDictionary` — словарь (числительные, единицы, исправления, маркеры самоисправлений, имена сотрудников `managerNames`), оба алфавита. ДАННЫЕ, пополняется без правки кода |
| `js/normalize.js` | `window.Normalizer.normalizeTranscript()` — этап между Whisper и GPT |
| `js/client-detect.js` | `window.ClientDetect.pickClient()` — выбор клиента из нескольких имён (база/приветствия/сотрудники). Чистая логика, тесты в `tests/` |
| `js/openai.js` | Whisper + GPT-4o-mini, режимы edge/direct, системный промпт |
| `js/excel.js` | `window.ExcelUtils.downloadOrderExcel(order)` — выгрузка XLSX |
| `supabase/functions/openaiproxy/index.ts` | Edge Function — прокси к OpenAI |
| `sql/schema.sql` | Таблицы `orders`, `clients`, `products`, `order_logs` + бакет `order-audio` + RLS |
| `config.js` | Конфигурация (хранится в репозитории: только публичные значения, ключ OpenAI — никогда) |

## Критические правила

1. **Клиент Supabase.** `window.supabase` — это UMD-библиотека с CDN,
   `window.sb` — клиент, созданный в `js/supabase-client.js`.
   Обращения к БД ТОЛЬКО через `window.sb.from(...)`.
   Никогда не писать `window.supabase.from(...)`.

2. **Ключ OpenAI не попадает в браузер.** `OPENAI_MODE: "edge"` по умолчанию —
   все вызовы идут через Edge Function `openaiproxy`, ключ лежит в секретах
   Supabase. `config.js` хранится в репозитории (нужен GitHub Pages) и содержит
   только публичные значения: URL, anon-ключ Supabase, `OPENAI_API_KEY` всегда
   пустой. Режим `"direct"` (ключ вписан в config.js) — только локальный тест,
   такой файл НЕ коммитить.

3. **Системный промпт продублирован** в `js/openai.js` (direct) и
   `supabase/functions/openaiproxy/index.ts` (edge).
   Любые изменения промпта вносить в ОБА файла синхронно.

4. **Таблица позиций (new-order) не перерисовывается при вводе.**
   Обработчики `input` обновляют только модель (`items`), ячейку «Сумма» и
   подсветку строки — иначе сбрасывается фокус с инпута. Полная перерисовка
   `tbody` допустима только после распознавания; добавление/удаление строк —
   точечные `appendChild` / `tr.remove()` + перенумерация.

5. **Подсветка уточнений.** Жёлтым (`tr.row-warn`: фон `#fff7d6`,
   рамка `#f0d775`) выделяются строки, для которых `needsReview()` истинно:
   `qty == null`, `confidence === "low"`, `corrected === true` или
   `confidence_score < 60`. Правка названия снимает все пометки (имя
   подтверждено), правка количества снимает пометку самоисправления.

6. **Нормализация — только на фронтенде**, между Whisper и GPT
   (`js/new-order.js` → `Normalizer.normalizeTranscript()`). На разбор и в
   `orders.source_text` идёт нормализованный текст. Словарь — единственный
   источник в `js/dictionary.js` (Edge Function нормализацию НЕ делает).
   Пополнять словарь — правкой `js/dictionary.js`, без изменения `js/normalize.js`.

7. **Логирование (`order_logs`) — best-effort.** Сбой записи лога или загрузки
   аудио в Storage НЕ должен ломать сохранение заказа. Поэтому это отдельная
   таблица, а не колонки в `orders`: приём заказов работает даже без миграции.

8. **Определение клиента — по нескольким именам.** Модель отдаёт `name_candidates`
   (все имена + флаг `greeting`); клиента выбирает `ClientDetect.pickClient`:
   сотрудники (`managerNames`) исключаются, имя из базы клиентов в приоритете,
   среди равных предпочитается не приветственное. Чистую логику покрывают
   тесты `tests/client-detect.test.js` — менять её синхронно с ними.

## Данные

```
orders:     id uuid, created_at, client_name, client_phone,
            status ('new'|'processing'|'ready'), items jsonb, source_text, excel_url
clients:    id uuid, created_at, name, phone, standard_order jsonb, notes
products:   id uuid, created_at, name, unit, price   (справочник, импорт из admin.html)
order_logs: id uuid, created_at, order_id, client_name, source, audio_url,
            transcript_raw, transcript_normalized, corrections jsonb,
            had_self_correction, items jsonb   (логи распознавания для обучения)
```

Элемент `items` / `standard_order`:
`{ name, qty: number|null, unit, price: number|null, confidence: "high"|"medium"|"low",
   confidence_score: 0..100, corrected: boolean, note }`
Поля `confidence_score` / `corrected` опциональны: если модель их не вернула,
`normalizeItem()` выводит их из `confidence` и `qty` (обратная совместимость).

Заказы связаны с клиентом по `client_name` (текст, без FK) — MVP-упрощение.

## Дизайн

Белый фон, тёмно-серый текст, акцент `#0d7d6f`, sticky-шапка с навигацией,
адаптив до мобильных. Все стили в `css/style.css`, палитра в `:root`.
Excel: колонки `№ | Наименование | Количество | Ед.изм. | Цена | Сумма`,
имя файла `Заказ_[клиент]_[дата].xlsx`.
