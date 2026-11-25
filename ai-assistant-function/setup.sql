-- FM Physio AI Assistant — one-time SQL setup
-- Run ONCE in the Supabase Dashboard → SQL Editor (project qyvkseltcebgkojmmuno).
-- What it creates:
--   1. Supabase Vault extension (encrypted secret store for the provider key).
--   2. public.ai_settings — ONE row (id=1): provider, model, base_url,
--      updated_at. RLS ON with NO policies = no client (browser)
--      can ever read or write it; only the service role (Edge Function) can.
--      The API key itself is NEVER stored in this table.
--   3. fm_save_ai_secret / fm_get_ai_secret — SECURITY DEFINER helpers so the
--      Edge Function can write/read the Vault secret. Revoked from anon and
--      authenticated: only service_role may execute them.
-- The provider key is NEVER returned to the browser by any of this.

create extension if not exists supabase_vault;

create table if not exists public.ai_settings (
  id int primary key,
  provider text,
  model text,
  base_url text,
  updated_at timestamptz default now()
);
alter table public.ai_settings enable row level security;
-- Intentionally NO policies: deny-all for every client role. Service role
-- bypasses RLS, which is exactly what the Edge Function uses.
-- IMPORTANT (learned 25 Nov 2026): raw-SQL CREATE TABLE gives the table NO
-- privileges for service_role, so the Edge Function's SELECT/UPSERT fails
-- with 42501 "permission denied" and saving a key shows "Could not save
-- settings." — this GRANT is required:
grant all on table public.ai_settings to service_role;

create or replace function public.fm_save_ai_secret(p_name text, p_secret text)
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
    return vault.create_secret(p_secret, p_name, 'FM Physio AI assistant provider key');
  end if;
end;
$$;
revoke all on function public.fm_save_ai_secret(text, text) from public, anon, authenticated;
grant execute on function public.fm_save_ai_secret(text, text) to service_role;

create or replace function public.fm_get_ai_secret(p_name text)
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
revoke all on function public.fm_get_ai_secret(text) from public, anon, authenticated;
grant execute on function public.fm_get_ai_secret(text) to service_role;

-- fm_delete_ai_secret — removes the Vault secret AND the settings row,
-- so the assistant returns to "Not configured". Used by the dashboard's
-- "Delete key" button (Edge Function action delete_key).
-- NOTE (25 Nov 2026): this project's Vault has NO vault.delete_secret
-- function, so the secret row is deleted directly from vault.secrets.
create or replace function public.fm_delete_ai_secret()
returns void
language plpgsql
security definer
as $$
begin
  delete from vault.secrets where name = 'fm_ai_provider_key';
  delete from public.ai_settings where id = 1;
end;
$$;
revoke all on function public.fm_delete_ai_secret() from public, anon, authenticated;
grant execute on function public.fm_delete_ai_secret() to service_role;

-- Verify (should return one row each; the secret value itself is NOT shown):
--   select * from public.ai_settings;              -- empty until first save
--   select id, name from vault.secrets;            -- empty until first save
--   select proname from pg_proc where proname like 'fm_%';

-- RESET (owner only, SQL Editor): deletes settings + the Vault secret,
-- so the next save starts fresh. (No vault.delete_secret function exists
-- on this project — delete the secret row directly.)
--   delete from public.ai_settings where id = 1;
--   delete from vault.secrets where name = 'fm_ai_provider_key';
