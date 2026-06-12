# ZakazBot — приём заказов HoReCa

MVP веб-приложения для менеджера поставщика HoReCa: клиент присылает голосовое
сообщение или текст → система расшифровывает аудио (OpenAI Whisper), разбирает
заказ на позиции (GPT-4o-mini) → менеджер проверяет таблицу → готовый Excel
для 1С. Заказы и клиенты хранятся в Supabase.

```
Голосовое / текст клиента
        │
        ▼
   Whisper (расшифровка)
        │
        ▼
   GPT-4o-mini (товары, количество, ед.изм., уверенность)
        │
        ▼
   Редактируемая таблица  ──►  Excel для 1С (SheetJS)
        │
        ▼
   Supabase (orders / clients)
```

## Страницы

| Страница | Что умеет |
|---|---|
| `index.html` | Входящие заказы: статусы (new / processing / ready), поиск по клиенту, фильтр по статусу и дате (сегодня / всё время), смена статуса, скачивание Excel, удаление |
| `new-order.html` | Создание заказа: аудио (.ogg/.mp3/.wav/.m4a) или текст → «Распознать заказ» → редактируемая таблица позиций (жёлтым — что нужно уточнить), клиент и телефон, Excel, сохранение |
| `clients.html` | База клиентов: поиск, история заказов, стандартный заказ — подставляется, когда клиент говорит «как обычно» |

## Стек

- **Frontend:** чистый HTML/CSS/JS, без фреймворков и сборки
- **Backend:** Supabase (Postgres + Edge Functions)
- **ИИ:** OpenAI Whisper (`whisper-1`) + GPT-4o-mini
- **Excel:** SheetJS (CDN)
- **Хостинг:** GitHub Pages (статика)

## Установка

### 1. Supabase

1. Создайте проект на [supabase.com](https://supabase.com).
2. **SQL Editor** → выполните содержимое `sql/schema.sql`
   (таблицы `orders` и `clients` + открытые RLS-политики для MVP).
3. Установите [Supabase CLI](https://supabase.com/docs/guides/cli) и
   задеплойте Edge Function с ключом OpenAI:

   ```bash
   supabase login
   supabase link --project-ref <PROJECT_REF>
   supabase secrets set OPENAI_API_KEY=sk-...
   supabase functions deploy openai-proxy
   ```

### 2. Конфигурация фронтенда

```bash
cp config.example.js config.js
```

Заполните в `config.js`:

- `SUPABASE_URL` и `SUPABASE_ANON_KEY` — Supabase → Settings → API;
- `OPENAI_MODE: "edge"` — оставить как есть (ключ OpenAI остаётся на сервере).

### 3. Локальный запуск

```bash
npx serve .
```

Откройте http://localhost:3000 — все три страницы работают как статика.

### 4. Деплой на GitHub Pages

1. GitHub → Settings → Pages → Deploy from a branch → ветка `main`, папка `/ (root)`.
2. `config.js` находится в `.gitignore` (защита от утечки ключа). Для Pages
   файл нужен в репозитории — добавьте его осознанно, предварительно убедившись,
   что `OPENAI_MODE: "edge"` и `OPENAI_API_KEY: ""` (пустой!):

   ```bash
   git add -f config.js
   git commit -m "config.js для GitHub Pages (без секретов)"
   ```

   Анонимный ключ Supabase — публичный по дизайну, его публиковать можно.
   Ключ OpenAI публиковать нельзя никогда.

## Режимы обращения к OpenAI

| Режим | Где живёт ключ | Когда использовать |
|---|---|---|
| `edge` (по умолчанию) | Секреты Supabase, в браузер не попадает | Всегда, включая прод |
| `direct` | `config.js` в браузере | Только локальная отладка |

## Распознавание

Системный промпт (продублирован в `js/openai.js` и
`supabase/functions/openai-proxy/index.ts`) возвращает строгий JSON:
клиент, комментарий, флаги `urgent` / `repeat_last_order` и список позиций
с `confidence`. Строки с `confidence=low` или без количества подсвечиваются
жёлтым — менеджер уточняет их перед выгрузкой. Понимает русский и узбекский
(dona=штук, juft=пар, qop=мешок). Фраза «как обычно» подставляет стандартный
заказ клиента из базы.

## Безопасность (важно для MVP)

- RLS-политики открыты для `anon`: любой, у кого есть anon-ключ, может читать
  и менять данные. Для продакшена включите Supabase Auth и используйте
  закомментированный блок политик в `sql/schema.sql`.
- Ключ OpenAI хранится только в секретах Supabase (режим `edge`).

## Структура проекта

```
├── index.html              # Входящие заказы
├── new-order.html          # Создание заказа
├── clients.html            # База клиентов
├── config.example.js       # Шаблон конфигурации
├── config.js               # Локальная конфигурация (в .gitignore)
├── css/
│   └── style.css
├── js/
│   ├── supabase-client.js  # window.sb — клиент Supabase
│   ├── openai.js           # Whisper + GPT-4o-mini (edge/direct)
│   ├── excel.js            # Выгрузка XLSX (SheetJS)
│   ├── orders.js           # Логика index.html
│   ├── new-order.js        # Логика new-order.html
│   └── clients.js          # Логика clients.html
├── sql/
│   └── schema.sql          # Таблицы + RLS
├── supabase/functions/openai-proxy/
│   └── index.ts            # Edge Function — прокси к OpenAI
├── CLAUDE.md
└── README.md
```
