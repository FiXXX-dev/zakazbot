-- ZakazBot: схема БД (Supabase / Postgres).
-- Выполните в Supabase: SQL Editor → New query → вставить → Run.

-- ─── Таблицы ────────────────────────────────────────────────────────

create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  client_name  text,
  client_phone text,
  status       text not null default 'new'
               check (status in ('new', 'processing', 'ready')),
  items        jsonb not null default '[]'::jsonb,
  source_text  text,
  excel_url    text
);

create table if not exists public.clients (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  name           text not null,
  phone          text,
  standard_order jsonb not null default '[]'::jsonb,
  notes          text
);

create table if not exists public.products (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  unit       text,
  price      numeric
);

-- Элемент items / standard_order (jsonb):
-- { "name": "Салфетки", "qty": 10, "unit": "уп", "price": 12000,
--   "confidence": "high", "confidence_score": 90, "corrected": false, "note": "" }

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx     on public.orders (status);
create index if not exists orders_client_idx     on public.orders (client_name);
create index if not exists clients_name_idx      on public.clients (name);
create index if not exists products_name_idx     on public.products (name);

-- ─── RLS ────────────────────────────────────────────────────────────

alter table public.orders   enable row level security;
alter table public.clients  enable row level security;
alter table public.products enable row level security;

-- MVP: открытый доступ для анонимного ключа (anon).
-- ВНИМАНИЕ: любой, у кого есть anon-ключ, может читать и менять данные.
-- Для продакшена удалите эти политики и используйте блок с authenticated ниже.

create policy "orders anon full access" on public.orders
  for all to anon using (true) with check (true);

create policy "clients anon full access" on public.clients
  for all to anon using (true) with check (true);

create policy "products anon full access" on public.products
  for all to anon using (true) with check (true);

-- ─── Продакшен-вариант: только авторизованные пользователи ──────────
-- Включите Supabase Auth, затем выполните:
--
-- drop policy if exists "orders anon full access"   on public.orders;
-- drop policy if exists "clients anon full access"  on public.clients;
-- drop policy if exists "products anon full access" on public.products;
--
-- create policy "orders authenticated full access" on public.orders
--   for all to authenticated using (true) with check (true);
--
-- create policy "clients authenticated full access" on public.clients
--   for all to authenticated using (true) with check (true);
--
-- create policy "products authenticated full access" on public.products
--   for all to authenticated using (true) with check (true);

-- ─── Логи распознавания (для обучения системы) ──────────────────────
-- Сохраняет исходную и нормализованную расшифровку, аудио и итоговый заказ.
-- Отдельная таблица (а не колонки в orders) — чтобы приём заказов работал
-- даже без этой миграции: логирование на фронтенде best-effort.

create table if not exists public.order_logs (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  order_id              uuid references public.orders(id) on delete set null,
  client_name           text,
  source                text,            -- 'audio' | 'text'
  audio_url             text,            -- ссылка на файл в бакете order-audio
  transcript_raw        text,            -- исходная расшифровка Whisper
  transcript_normalized text,            -- после normalize_transcript()
  corrections           jsonb not null default '[]'::jsonb,
  had_self_correction   boolean not null default false,
  items                 jsonb not null default '[]'::jsonb
);

create index if not exists order_logs_created_at_idx on public.order_logs (created_at desc);
create index if not exists order_logs_order_idx      on public.order_logs (order_id);

alter table public.order_logs enable row level security;

drop policy if exists "order_logs anon full access" on public.order_logs;
create policy "order_logs anon full access" on public.order_logs
  for all to anon using (true) with check (true);

-- ─── Хранилище аудио (Supabase Storage) ─────────────────────────────
-- Публичный бакет для логирования голосовых сообщений. Если этот блок не
-- выполнять, заказы и логи продолжат работать — просто audio_url будет пустым.

insert into storage.buckets (id, name, public)
values ('order-audio', 'order-audio', true)
on conflict (id) do nothing;

drop policy if exists "order-audio anon read"   on storage.objects;
drop policy if exists "order-audio anon insert" on storage.objects;

create policy "order-audio anon read" on storage.objects
  for select to anon using (bucket_id = 'order-audio');

create policy "order-audio anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'order-audio');
