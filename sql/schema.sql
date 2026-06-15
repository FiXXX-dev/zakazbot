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

-- ═══════════════════════════════════════════════════════════════════
-- Auth и разделение доступа (мультиарендность)
-- ═══════════════════════════════════════════════════════════════════
-- Включите Supabase Auth (Email). После этой миграции каждая строка
-- принадлежит пользователю (user_id), и пользователь видит ТОЛЬКО свои данные.
-- Администратор (см. is_admin ниже) видит всё — для dashboard.html.
--
-- ВАЖНО (миграция существующих данных): у старых строк user_id = NULL, и после
-- включения политик они станут невидимы. Привяжите их к своему аккаунту:
--   select id, email from auth.users;                    -- найдите свой UID
--   update public.orders     set user_id = '<UID>' where user_id is null;
--   update public.clients    set user_id = '<UID>' where user_id is null;
--   update public.products   set user_id = '<UID>' where user_id is null;
--   update public.order_logs set user_id = '<UID>' where user_id is null;

-- ─── user_id во всех рабочих таблицах (default = текущий пользователь) ──
alter table public.orders     add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.clients    add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.products   add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.order_logs add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();

create index if not exists orders_user_idx     on public.orders (user_id);
create index if not exists clients_user_idx    on public.clients (user_id);
create index if not exists products_user_idx   on public.products (user_id);
create index if not exists order_logs_user_idx on public.order_logs (user_id);

-- ─── Кто администратор (для dashboard.html) ─────────────────────────
-- МЕНЯЙТЕ email на свой. Должен совпадать с CONFIG.ADMIN_EMAIL в config.js.
create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select coalesce(lower(auth.jwt() ->> 'email') = lower('nurmuhamedovsa@gmail.com'), false);
$$;

-- ─── Подписки клиентов ──────────────────────────────────────────────
create table if not exists public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  client_name text,
  status      text not null default 'active'  check (status in ('active', 'expired')),
  plan        text not null default 'basic'   check (plan in ('basic', 'pro')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  unique (user_id)
);

-- Миграция существующей таблицы к (basic/pro) + expires_at (idempotent):
alter table public.subscriptions add column if not exists expires_at timestamptz;
update public.subscriptions set plan = 'pro' where plan in ('standard', 'business');
alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('basic', 'pro'));

-- ─── Лимиты и фичи тарифов (справочник) ─────────────────────────────
create table if not exists public.plan_limits (
  plan                 text primary key,
  max_products         integer,        -- NULL = безлимит
  max_clients          integer,        -- NULL = безлимит
  has_analytics        boolean not null default false,
  has_1c_integration   boolean not null default false,
  has_priority_support boolean not null default false,
  has_custom_branding  boolean not null default false
);

insert into public.plan_limits
  (plan, max_products, max_clients, has_analytics, has_1c_integration, has_priority_support, has_custom_branding)
values
  ('basic', 500, 50, false, false, false, false),
  ('pro',   null, null, true, true, true, true)
on conflict (plan) do update set
  max_products         = excluded.max_products,
  max_clients          = excluded.max_clients,
  has_analytics        = excluded.has_analytics,
  has_1c_integration   = excluded.has_1c_integration,
  has_priority_support = excluded.has_priority_support,
  has_custom_branding  = excluded.has_custom_branding;

alter table public.plan_limits enable row level security;
drop policy if exists "plan_limits read" on public.plan_limits;
create policy "plan_limits read" on public.plan_limits
  for select to authenticated using (true);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);
alter table public.subscriptions enable row level security;

-- ─── Политики: владелец видит своё, админ — всё ─────────────────────
-- Меняем открытые anon-политики на доступ для авторизованных по user_id.
drop policy if exists "orders anon full access"   on public.orders;
drop policy if exists "clients anon full access"  on public.clients;
drop policy if exists "products anon full access" on public.products;
drop policy if exists "order_logs anon full access" on public.order_logs;

drop policy if exists "orders owner access"     on public.orders;
drop policy if exists "clients owner access"    on public.clients;
drop policy if exists "products owner access"   on public.products;
drop policy if exists "order_logs owner access" on public.order_logs;

create policy "orders owner access" on public.orders
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "clients owner access" on public.clients
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "products owner access" on public.products
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "order_logs owner access" on public.order_logs
  for all to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- subscriptions: пользователь видит и создаёт ТОЛЬКО свою (active/basic),
-- менять статус/план может только администратор (чтобы нельзя было
-- самому себе продлить подписку).
drop policy if exists "subs select" on public.subscriptions;
drop policy if exists "subs insert" on public.subscriptions;
drop policy if exists "subs update" on public.subscriptions;
drop policy if exists "subs delete" on public.subscriptions;

create policy "subs select" on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "subs insert" on public.subscriptions
  for insert to authenticated
  with check ((user_id = auth.uid() and status = 'active' and plan = 'basic') or public.is_admin());

create policy "subs update" on public.subscriptions
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "subs delete" on public.subscriptions
  for delete to authenticated
  using (public.is_admin());

-- ─── Storage: загрузка/чтение аудио для авторизованных ──────────────
drop policy if exists "order-audio anon read"   on storage.objects;
drop policy if exists "order-audio anon insert" on storage.objects;
drop policy if exists "order-audio auth read"   on storage.objects;
drop policy if exists "order-audio auth insert" on storage.objects;

create policy "order-audio auth read" on storage.objects
  for select to authenticated using (bucket_id = 'order-audio');
create policy "order-audio auth insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'order-audio');
