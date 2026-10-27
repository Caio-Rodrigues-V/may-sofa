-- Sofás May - compatibilidade com o painel Smart Trigo (prompt, aprovações e busca semântica).
-- Migração aditiva: não apaga dados nem colunas existentes.

begin;

create extension if not exists vector;

-- 1. Versões de prompt editadas pelo painel e lidas pelo agente (active = true mais recente).
create table if not exists public.sofas_may_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  prompt_text text not null,
  notes text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
create index if not exists sofas_may_prompt_versions_active_idx on public.sofas_may_prompt_versions(active, created_at desc);
alter table public.sofas_may_prompt_versions enable row level security;

-- 2. O painel grava review_status = 'pending' nas propostas de clientes.
do $$
declare t text;
begin
  foreach t in array array['products','product_variants','prices','media','knowledge','commercial_rules'] loop
    execute format('alter table public.sofas_may_%s drop constraint if exists sofas_may_%s_review_status_check', t, t);
    execute format($f$alter table public.sofas_may_%s add constraint sofas_may_%s_review_status_check
      check (review_status in ('pending','pending_review','approved','rejected','superseded'))$f$, t, t);
  end loop;
end $$;

-- 3. Colunas que o painel grava ou lê.
alter table public.sofas_may_knowledge
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists effective_from timestamptz,
  add column if not exists effective_until timestamptz,
  add column if not exists embedding vector(1536);
alter table public.sofas_may_media
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists usage_type text,
  add column if not exists description text,
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists duration_seconds numeric,
  add column if not exists checksum text;
alter table public.sofas_may_prices
  add column if not exists updated_at timestamptz not null default now(),
  alter column variant_id drop not null;
alter table public.sofas_may_product_variants
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists module_count integer;
alter table public.sofas_may_commercial_rules
  add column if not exists updated_at timestamptz not null default now();

-- 4. Busca semântica nos cards aprovados (embeddings gerados pelo painel ao salvar/aprovar).
create index if not exists sofas_may_knowledge_embedding_idx
  on public.sofas_may_knowledge using hnsw (embedding vector_cosine_ops);

create or replace function public.sofas_may_match_knowledge(
  p_embedding vector(1536),
  p_limit integer default 6
) returns table (topic text, title text, content text, priority integer, similarity float)
language sql stable security invoker set search_path = public, extensions as $$
  select k.topic, k.title, k.content, k.priority, (1 - (k.embedding <=> p_embedding))::float as similarity
  from public.sofas_may_knowledge k
  where k.active = true
    and k.review_status = 'approved'
    and k.embedding is not null
    and (k.effective_from is null or k.effective_from <= now())
    and (k.effective_until is null or k.effective_until >= now())
  order by k.embedding <=> p_embedding asc
  limit least(greatest(coalesce(p_limit, 6), 1), 20);
$$;

revoke all on function public.sofas_may_match_knowledge(vector, integer) from public, anon, authenticated;
grant execute on function public.sofas_may_match_knowledge(vector, integer) to service_role;

commit;
