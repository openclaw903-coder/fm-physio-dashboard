-- FM Physio AI call costs — one-time SQL setup
-- Run ONCE in the Supabase Dashboard → SQL Editor (project qyvkseltcebgkojmmuno).
-- What it creates:
--   1. Supabase Vault extension (encrypted secret store for the keys).
--   2. public.ai_cost_settings — ONE row per provider (retell / vapi):
--      provider, configured, updated_at. RLS ON with NO policies = no
--      client (browser) can ever read or write it; only the service role
--      (Edge Function) can. The API keys themselves are NEVER stored here.
--   3. fm_save_cost_secret / fm_get_cost_secret / fm_delete_cost_secret —
--      SECURITY DEFINER helpers so the Edge Function can write/read/delete
--      the Vault secrets. Revoked from anon and authenticated: only
--      service_role may execute them.
-- The Retell + Vapi keys are NEVER returned to the browser by any of this.
-- Vault secrets: fm_retell_api_key, fm_vapi_api_key (new names — the AI
-- assistant key fm_ai_provider_key is NOT reused).

create extension if not exists supabase_vault;

create table if not exists public.ai_cost_settings (
  provider text primary key,
  configured boolean not null default false,
  updated_at timestamptz default now()
);
alter table public.ai_cost_settings enable row level security;
-- Intentionally NO policies: deny-all for every client role. Service role
-- bypasses RLS, which is exactly what the Edge Function uses.
-- IMPORTANT (learned 25 Nov 2026 on ai_settings): raw-SQL CREATE TABLE
-- gives the table NO privileges for service_role, so the Edge Function's
-- SELECT/UPSERT fails with 42501 "permission denied" — this GRANT is
-- required:
grant all on table public.ai_cost_settings to service_role;

create or replace function public.fm_save_cost_secret(p_name text, p_secret text)
returns uuid
language plpgsql
security definer
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is not null then
    perform vault.update_secret(v_id, p_secret);
    return v_id;
  else
    return vault.create_secret(p_secret, p_name, 'FM Physio AI call-cost key');
  end if;
end;
$$;
revoke all on function public.fm_save_cost_secret(text, text) from public, anon, authenticated;
grant execute on function public.fm_save_cost_secret(text, text) to service_role;

create or replace function public.fm_get_cost_secret(p_name text)
returns text
language plpgsql
security definer
as $$
declare
  v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  return v;
end;
$$;
revoke all on function public.fm_get_cost_secret(text) from public, anon, authenticated;
grant execute on function public.fm_get_cost_secret(text) to service_role;

-- fm_delete_cost_secret — removes the Vault secret AND the settings row
-- for that provider, so it returns to "Not configured". Used by the
-- dashboard's "Delete Retell/Vapi key" buttons (Edge Function actions
-- delete_retell_key / delete_vapi_key).
-- NOTE: this project's Vault has NO vault.delete_secret function, so the
-- secret row is deleted directly from vault.secrets.
create or replace function public.fm_delete_cost_secret(p_name text, p_provider text)
returns void
language plpgsql
security definer
as $$
begin
  delete from vault.secrets where name = p_name;
  delete from public.ai_cost_settings where provider = p_provider;
end;
$$;
revoke all on function public.fm_delete_cost_secret(text, text) from public, anon, authenticated;
grant execute on function public.fm_delete_cost_secret(text, text) to service_role;

-- Verify (should return one row each; the secret values are NOT shown):
--   select * from public.ai_cost_settings;              -- empty until first save
--   select id, name from vault.secrets;                 -- empty until first save
--   select proname from pg_proc where proname like 'fm_%cost%';

-- RESET (owner only, SQL Editor): deletes settings + both Vault secrets,
-- so the next save starts fresh. (No vault.delete_secret function exists
-- on this project — delete the secret rows directly.)
--   delete from public.ai_cost_settings;
--   delete from vault.secrets where name in ('fm_retell_api_key', 'fm_vapi_api_key');

-- ROLLBACK (owner only, SQL Editor): removes everything this file created.
-- (The Vault extension itself is shared with ai-assistant — do NOT drop it
-- unless the AI assistant setup is also being removed.)
--   drop function if exists public.fm_delete_cost_secret(text, text);
--   drop function if exists public.fm_get_cost_secret(text);
--   drop function if exists public.fm_save_cost_secret(text, text);
--   drop table if exists public.ai_cost_settings;
