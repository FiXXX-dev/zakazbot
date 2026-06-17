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
- Юнит-тесты логики (без браузера): `node tests/client-detect.test.js`,
  `node tests/order-merge.test.js`
- Схема БД: выполнить `sql/schema.sql` в SQL Editor Supabase
- Edge Function: `supabase functions deploy openaiproxy`,
  ключ: `supabase secrets set OPENAI_API_KEY=sk-...`

## Структура

| Файл | Назначение |
|---|---|
| `index.html` + `js/orders.js` | Входящие заказы: поиск, фильтры (статус, сегодня/всё время), смена статуса, Excel, удаление |
| `new-order.html` + `js/new-order.js` | Распознавание аудио/текста, редактируемая таблица позиций, Excel, сохранение |
| `clients.html` + `js/clients.js` | Клиенты: поиск, история заказов, стандартный заказ («как обычно»); вкладка «Telegram-клиенты» — привязка ТГ-чатов (`telegram_links`) к клиентам базы |
| `admin.html` + `js/admin.js` | Импорт товаров и клиентов из .csv/.xlsx (SheetJS) в `products` / `clients` (на текущего пользователя) |
| `admin-dashboard.html` + `js/admin-dashboard.js` | Админка владельца: создание клиентов, выдача ACCESS_KEY (+копировать), управление планом/статусом. Пароль проверяет `clientauth` (секрет `ADMIN_PANEL_SECRET`), не в репозитории |
| `settings.html` + `js/settings.js` | Тариф клиента: текущий план/даты, сравнение Basic/Pro, заявка на Upgrade (письмо админу) |
| `js/supabase-client.js` | Создаёт `window.sb` (клиент Supabase) |
| `js/auth.js` | `window.Auth` — вход клиента по ACCESS_KEY (`keyLogin`/`guard`): нет сессии → форма ключа вместо контента; инъекция «Тариф»/«Выйти». Гард грузит `Plan` и рисует баннеры |
| `js/plan.js` | `window.Plan` — загрузка подписки + `plan_limits` (фичефлаги/лимиты), `isPro()`, `has(feature)`, баннеры лимитов |
| `js/analytics.js` | `window.Analytics.render()` — дашборд (Chart.js) на вкладке «Аналитика» (только Pro): фильтр периода 30/90/всё, KPI (заказы/выручка/средний чек/клиенты), выручка и заказы по дням, статусы, топы клиентов/товаров по выручке |
| `js/dictionary.js` | `window.ZakazDictionary` — словарь (числительные, единицы, исправления, маркеры самоисправлений, имена сотрудников `managerNames`), оба алфавита. ДАННЫЕ, пополняется без правки кода |
| `js/normalize.js` | `window.Normalizer.normalizeTranscript()` — этап между Whisper и GPT |
| `js/client-detect.js` | `window.ClientDetect.pickClient()` — выбор клиента из нескольких имён (база/приветствия/сотрудники). Чистая логика, тесты в `tests/` |
| `js/order-merge.js` | `window.OrderMerge.mergeStandardOrder()` — слияние стандартного заказа с изменениями (дедуп); `matchProduct()` — однозначный поиск товара в каталоге для подстановки цены. Чистая логика, тесты в `tests/` |
| `roi.html` | Калькулятор окупаемости (отдельная страница для продаж, не в навигации) |
| `docs/pilot.md` | Одностраничник пилота для дистрибьютора (оффер, метрики, скрипт) |
| `js/openai.js` | Whisper + GPT-4o-mini, режимы edge/direct, системный промпт |
| `js/excel.js` | `window.ExcelUtils.downloadOrderExcel(order)` — выгрузка XLSX |
| `supabase/functions/openaiproxy/index.ts` | Edge Function — прокси к OpenAI |
| `supabase/functions/clientauth/index.ts` | Edge Function (service-role) — вход по ACCESS_KEY и админ-операции (создание/список/обновление клиентов) |
| `supabase/functions/tgbot/index.ts` (+ `normalize.ts`) | Telegram-бот: голос/текст → Whisper → нормализация → GPT → подтверждение → сохранение заказа. Привязка чата по ACCESS_KEY |
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

3. **Системный промпт продублирован** в ТРЁХ местах: `js/openai.js` (direct),
   `supabase/functions/openaiproxy/index.ts` (edge) и
   `supabase/functions/tgbot/index.ts` (Telegram-бот).
   Любые изменения промпта вносить во все три файла синхронно.
   Аналогично нормализация: `js/dictionary.js`+`js/normalize.js` (фронт) и
   `supabase/functions/tgbot/normalize.ts` (порт для бота) — держать в синхроне.

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

9. **Доступ по ACCESS_KEY (без регистрации).** Клиент = пользователь Supabase
   Auth (синтетический email, пароль = ключ). `Auth.guard()` на
   index/new-order/clients/admin/settings: нет сессии → форма ключа вместо
   контента. Ключ меняется на сессию через Edge Function `clientauth`
   (service-role); `clients_accounts` закрыта RLS и публично не читается.
   Данные изолируют RLS по `user_id = auth.uid()` + фильтр `.eq("user_id", …)`.
   Аккаунты создаёт владелец в `admin-dashboard.html` (пароль — серверный секрет
   `ADMIN_PANEL_SECRET`, НЕ в config.js). Регистрации/`login.html` больше нет.

10. **Тарифы (basic/pro).** Лимиты и фичи — в `plan_limits` (`js/plan.js`).
    Баннеры лимитов рисует `Auth.guard()` → `Plan.renderBanners()` на страницах,
    где подключён `js/plan.js`. Гейтинг — мягкий: баннеры предупреждают, но не
    блокируют (жёсткой блокировки при превышении лимита/`expired` пока нет).
    Вкладка «Аналитика» и кнопка Upgrade завязаны на `Plan.isPro()`/`has()`.

## Данные

```
orders:     id uuid, created_at, client_name, client_phone,
            status ('new'|'processing'|'ready'), items jsonb, source_text, excel_url
clients:    id uuid, created_at, name, phone, standard_order jsonb, notes
products:   id uuid, created_at, name, unit, price   (справочник, импорт из admin.html)
order_logs: id uuid, created_at, order_id, client_name, source, audio_url,
            transcript_raw, transcript_normalized, corrections jsonb,
            had_self_correction, items jsonb   (логи распознавания для обучения)
subscriptions: id uuid, user_id (uniq), client_name, status ('active'|'expired'),
            plan ('basic'|'pro'), created_at, expires_at
plan_limits: plan (pk 'basic'|'pro'), max_products, max_clients (NULL=безлимит),
            has_analytics, has_1c_integration, has_priority_support, has_custom_branding
clients_accounts: id uuid, company_name, email, access_key (uniq, 16 симв.),
            plan, status ('active'|'inactive'), user_id, auth_email,
            customer_code (uniq, для ссылки-приглашения кафе), created_at
            (закрыта RLS; читает только service role в clientauth)
telegram_links: chat_id (pk, bigint), user_id, company_name,
            role ('manager'|'customer'), client_name (кафе для customer),
            file_format ('xlsx'|'csv'), tg_username, tg_first_name, tg_last_name,
            pending_order jsonb, created_at
            (бот — service role; владелец читает/правит свои строки: RLS
             select/update по user_id = auth.uid() для вкладки «Telegram-клиенты»)
```

У `orders`/`clients`/`products`/`order_logs` есть `user_id` (владелец строки).
RLS: пользователь видит свои строки, админ (`is_admin()`) — все. `plan_limits` —
справочник, читают все авторизованные. Менять `plan`/`status` подписки может
только админ (через dashboard); пользователь не может сам себе включить Pro.

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
