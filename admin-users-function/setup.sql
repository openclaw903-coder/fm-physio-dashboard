-- Multi-user roles + per-page access (FM Physio dashboard)
-- Run once in the Supabase Dashboard SQL Editor (project qyvkseltcebgkojmmuno).
-- Stuart (owner) is the only account that manages users; physios and other
-- staff are 'user' rows with per-page access.

-- 1. Role on admin_users: 'owner' (Stuart only) or 'user' (physios / staff)
alter table public.admin_users add column if not exists role text not null default 'user' check (role in ('owner','user'));
update public.admin_users set role = 'owner' where user_id = '85884fb8-484f-423a-a891-ef9dd7bdd973';

-- 2. Per-page access: one row per (user, page). Owner always has all pages
-- (enforced in the Edge Function + dashboard, not by rows).
create table if not exists public.user_page_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  page_key text not null,
  allowed boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, page_key)
);
alter table public.user_page_access enable row level security;
drop policy if exists user_page_access_select on public.user_page_access;
create policy user_page_access_select on public.user_page_access for select to authenticated
  using (exists (select 1 from public.admin_users au where au.user_id = auth.uid() and au.active and (au.role = 'owner' or au.user_id = user_page_access.user_id)));
drop policy if exists user_page_access_write on public.user_page_access;
create policy user_page_access_write on public.user_page_access for all to authenticated
  using (exists (select 1 from public.admin_users au where au.user_id = auth.uid() and au.active and au.role = 'owner'))
  with check (exists (select 1 from public.admin_users au where au.user_id = auth.uid() and au.active and au.role = 'owner'));

-- 3. Grants (the Edge Function runs as service_role and must manage both tables)
grant select, insert, update, delete on public.user_page_access to authenticated;
grant all on public.user_page_access to service_role;
grant all on public.admin_users to service_role;

-- 4. Backfill: every existing admin user gets all 16 pages allowed
-- (keeps current access unchanged; new users get only the pages the owner ticks)
insert into public.user_page_access (user_id, page_key, allowed)
select au.user_id, p.page_key, true
from public.admin_users au
cross join (values ('overview'),('owner-overview'),('admin-today'),('appointments'),('patients'),('enquiries'),('cancellations'),('complaints'),('discharged'),('team'),('performance'),('progress'),('payments'),('ai'),('unprocessed'),('dnc')) as p(page_key)
on conflict (user_id, page_key) do nothing;
