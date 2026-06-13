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
| `admin.html` | Панель администратора: импорт товаров (таблица `products`) и клиентов (таблица `clients`) из файлов .csv/.xlsx |

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

`config.js` хранится в репозитории (он нужен GitHub Pages) и содержит только
публичные значения. Впишите в него:

- `SUPABASE_URL` и `SUPABASE_ANON_KEY` — Supabase → Settings → API
  (anon-ключ публичный по дизайну);
- `OPENAI_MODE: "edge"` — оставить как есть: ключ OpenAI живёт в секретах
  Supabase, поле `OPENAI_API_KEY` в репозитории всегда пустое.

### 3. Локальный запуск

```bash
npx serve .
```

Откройте http://localhost:3000 — все три страницы работают как статика.

### 4. Деплой на GitHub Pages

1. GitHub → Settings → Pages → Deploy from a branch → ветка `main`, папка `/ (root)`.
2. `config.js` уже в репозитории — перед публикацией убедитесь, что в нём
   `OPENAI_MODE: "edge"` и `OPENAI_API_KEY: ""` (пустой!).

   Анонимный ключ Supabase — публичный по дизайну, его публиковать можно.
   Ключ OpenAI публиковать нельзя никогда: для режима `direct` вписывайте его
   только локально и не коммитьте такой файл.

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
├── admin.html              # Панель администратора (импорт товаров/клиентов)
├── config.example.js       # Шаблон конфигурации
├── config.js               # Конфигурация (в репозитории, только публичные значения)
├── css/
│   └── style.css
├── js/
│   ├── supabase-client.js  # window.sb — клиент Supabase
│   ├── openai.js           # Whisper + GPT-4o-mini (edge/direct)
│   ├── excel.js            # Выгрузка XLSX (SheetJS)
│   ├── orders.js           # Логика index.html
│   ├── new-order.js        # Логика new-order.html
│   ├── clients.js          # Логика clients.html
│   └── admin.js            # Логика admin.html (импорт .csv/.xlsx)
├── sql/
│   └── schema.sql          # Таблицы + RLS
├── supabase/functions/openai-proxy/
│   └── index.ts            # Edge Function — прокси к OpenAI
├── CLAUDE.md
└── README.md
```
