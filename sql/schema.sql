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

-- Элемент items / standard_order (jsonb):
-- { "name": "Салфетки", "qty": 10, "unit": "уп", "price": 12000,
--   "confidence": "high", "note": "" }

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx     on public.orders (status);
create index if not exists orders_client_idx     on public.orders (client_name);
create index if not exists clients_name_idx      on public.clients (name);

-- ─── RLS ────────────────────────────────────────────────────────────

alter table public.orders  enable row level security;
alter table public.clients enable row level security;

-- MVP: открытый доступ для анонимного ключа (anon).
-- ВНИМАНИЕ: любой, у кого есть anon-ключ, может читать и менять данные.
-- Для продакшена удалите эти политики и используйте блок с authenticated ниже.

create policy "orders anon full access" on public.orders
  for all to anon using (true) with check (true);

create policy "clients anon full access" on public.clients
  for all to anon using (true) with check (true);

-- ─── Продакшен-вариант: только авторизованные пользователи ──────────
-- Включите Supabase Auth, затем выполните:
--
-- drop policy if exists "orders anon full access" on public.orders;
-- drop policy if exists "clients anon full access" on public.clients;
--
-- create policy "orders authenticated full access" on public.orders
--   for all to authenticated using (true) with check (true);
--
-- create policy "clients authenticated full access" on public.clients
--   for all to authenticated using (true) with check (true);
