create extension if not exists pgcrypto;

create table if not exists public.sofas_may_products (
  id uuid primary key default gen_random_uuid(), name text not null, slug text not null unique,
  product_type text not null, short_description text, technical_specs jsonb not null default '{}'::jsonb,
  official_url text, active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.sofas_may_product_aliases (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.sofas_may_products(id) on delete cascade,
  alias text not null, normalized_alias text not null, unique(product_id, normalized_alias)
);
create table if not exists public.sofas_may_product_variants (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.sofas_may_products(id) on delete cascade,
  label text not null, min_width_cm numeric, max_width_cm numeric, exact_width_cm numeric,
  fabric text, color text, configuration text, technical_specs jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now()
);
create table if not exists public.sofas_may_prices (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.sofas_may_products(id) on delete cascade,
  variant_id uuid not null references public.sofas_may_product_variants(id) on delete cascade,
  channel text not null, currency text not null default 'BRL', list_price numeric, cash_price numeric,
  installment_count integer, installment_value numeric, discount_percent numeric,
  valid_from timestamptz, valid_until timestamptz, active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now()
);
create table if not exists public.sofas_may_media (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.sofas_may_products(id) on delete cascade,
  variant_id uuid references public.sofas_may_product_variants(id) on delete set null,
  media_type text not null check (media_type in ('image','video')), mime_type text,
  storage_bucket text, storage_path text, public_url text, original_filename text,
  sort_order integer not null default 0, active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now(),
  check (public_url is not null or (storage_bucket is not null and storage_path is not null))
);
create table if not exists public.sofas_may_knowledge (
  id uuid primary key default gen_random_uuid(), topic text not null, title text not null, content text not null,
  priority integer not null default 0, active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  source text, created_at timestamptz not null default now(), unique(topic, title)
);
create table if not exists public.sofas_may_commercial_rules (
  id uuid primary key default gen_random_uuid(), rule_key text not null unique, rule_value jsonb not null,
  effective_from timestamptz, effective_until timestamptz, active boolean not null default true,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  created_at timestamptz not null default now()
);
create table if not exists public.sofas_may_events (
  id bigint generated always as identity primary key, session_id text, contact_id text,
  event_type text not null, event_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists sofas_may_media_product_idx on public.sofas_may_media(product_id, active, review_status);
create index if not exists sofas_may_prices_lookup_idx on public.sofas_may_prices(product_id, variant_id, channel, active, review_status);

alter table public.sofas_may_products enable row level security;
alter table public.sofas_may_product_aliases enable row level security;
alter table public.sofas_may_product_variants enable row level security;
alter table public.sofas_may_prices enable row level security;
alter table public.sofas_may_media enable row level security;
alter table public.sofas_may_knowledge enable row level security;
alter table public.sofas_may_commercial_rules enable row level security;
alter table public.sofas_may_events enable row level security;

insert into storage.buckets (id, name, public)
values ('sofas-may-catalog', 'sofas-may-catalog', false)
on conflict (id) do nothing;
