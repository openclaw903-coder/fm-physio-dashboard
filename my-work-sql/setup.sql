-- FM Physio — My Work (physio scoping) SQL
-- ============================================================
-- Run in the Supabase Dashboard SQL Editor, top to bottom, as the
-- project owner (or an org admin). Run it in ONE session, in order:
--   Section A first (column + grants) — needed before the
--   admin-users Edge Function is redeployed (set_practitioner
--   updates admin_users.practitioner_id).
--   Section B second (helpers + RPCs) — needed before the dashboard
--   My Work pages can load patient lists.
--   Section C last (RLS policies) — run BEFORE any my-* page is
--   granted to a physio. Until C runs, any active admin still sees
--   everything (old behaviour).
--
-- BEFORE APPLYING, save the current policies for rollback:
--   select tablename, policyname, cmd, qual, with_check
--   from pg_policies where schemaname = 'public'
--   and tablename in ('appointments','tasks','contacts','interactions');
-- The rollback statements are at the bottom of this file.
--
-- Verified data facts (28 Nov 2026):
--   appointments: 1,456 rows, practitioner_id NEVER null.
--   tasks: 1,353 rows, assigned_to NULL on ALL rows (never use it).
--   539 tasks have contact_id; some others carry metadata.appointment_id.
--   Tasks with neither link are SYSTEM tasks (e.g. api_outage) — they
--   match no physio rule below, so only the owner sees them.
--   Practitioners (practicehub_practitioners): 1 Stuart Goldfinch,
--   7 Kate Bennett, 8 Lucy Byott, 9 Arek Rogozinski, 11 Ethan Redmond,
--   12 Aadyaa Madhu. No email column anywhere on practitioners, so a
--   login can only be linked to a physio by the owner picking the id.
--   admin_users has NO email column; key is user_id (auth UUID).
--
-- Effect on existing users (read before running Section C):
--   Owner (role='owner') keeps full access everywhere — unchanged.
--   Every other user is treated as a physio: they only see rows
--   linked to their practitioner_id. A user with NO mapping sees
--   NOTHING (empty lists) until the owner maps them in Users & Access.
--   That includes the temporary logins (Ayyaz etc.) — map them or
--   remove them; do not be surprised when their pages go empty.

-- ================= SECTION A: mapping column + grants =============

alter table public.admin_users
  add column if not exists practitioner_id integer;

comment on column public.admin_users.practitioner_id is
  'practicehub_practitioners.practitioner_id of the physio this login belongs to. NULL = owner or unmapped user (sees no physio rows). Set by the owner in Users & Access via the admin-users Edge Function (set_practitioner).';

-- The admin-users Edge Function (service_role) updates this column.
grant all on table public.admin_users to service_role;

-- The dashboard (authenticated users) reads the practitioner list for
-- names, and the admin-users function validates ids against it.
grant select on table public.practicehub_practitioners to authenticated;
grant all on table public.practicehub_practitioners to service_role;

-- ================= SECTION B: helpers + RPCs ======================
-- All SECURITY DEFINER, so they run as postgres and bypass RLS
-- internally — but each one enforces the caller check itself
-- (owner, or the caller's own practitioner link). Callers only ever
-- receive their own rows.

-- The signed-in user's practitioner id, or NULL for the owner /
-- unmapped users / anyone with no admin_users row.
create or replace function public.fn_my_practitioner_id()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select practitioner_id
  from public.admin_users
  where user_id = auth.uid() and active
  limit 1;
$$;
grant execute on function public.fn_my_practitioner_id() to authenticated;

-- Contact ids whose MOST RECENT appointment is with the caller.
-- This is the "My Patients" list: a patient who moved to another
-- physio stops appearing here (their most recent appointment wins).
create or replace function public.fn_my_patient_ids()
returns table (contact_id bigint)
language sql
stable
security definer
set search_path = public
as $$
  select m.contact_id
  from (
    select distinct on (a.contact_id) a.contact_id, a.practitioner_id
    from public.appointments a
    where a.contact_id is not null
    order by a.contact_id, a.starts_at desc nulls last, a.id desc
  ) m
  where m.practitioner_id = public.fn_my_practitioner_id();
$$;
grant execute on function public.fn_my_patient_ids() to authenticated;

-- Full appointment history for ONE contact, with practitioner names.
-- Allowed only for the owner, or for a physio who has at least one
-- appointment with that contact. Anyone else gets zero rows (the
-- previous physios stay visible to the current physio — that history
-- is the patient's own clinical record, and the caller already has a
-- link to this patient).
create or replace function public.fn_patient_history(p_contact_id bigint)
returns table (
  appointment_id bigint,
  practitioner_id integer,
  practitioner_name text,
  status text,
  starts_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.practitioner_id, p.name, a.status, a.starts_at
  from public.appointments a
  left join public.practicehub_practitioners p
    on p.practitioner_id = a.practitioner_id
  where a.contact_id = p_contact_id
    and (
      exists (
        select 1 from public.admin_users au
        where au.user_id = auth.uid() and au.active and au.role = 'owner'
      )
      or exists (
        select 1 from public.appointments a2
        where a2.contact_id = p_contact_id
          and a2.practitioner_id = public.fn_my_practitioner_id()
      )
    )
  order by a.starts_at desc nulls last, a.id desc;
$$;
grant execute on function public.fn_patient_history(bigint) to authenticated;

-- ================= SECTION C: RLS policies ========================
-- The old policies let EVERY active admin see everything. Each policy
-- below is dropped and recreated with the same name, now:
--   owner  -> everything (unchanged behaviour)
--   physio -> only rows linked to their practitioner_id
-- INSERT policies are NOT changed (n8n writes with the service key,
-- which bypasses RLS; the dashboard inserts nothing into these tables).

-- --- appointments: practitioner_id = mine ---
drop policy if exists appointments_admin_select on public.appointments;
create policy appointments_admin_select on public.appointments
for select to authenticated using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or practitioner_id = public.fn_my_practitioner_id()
);

drop policy if exists appointments_admin_update on public.appointments;
create policy appointments_admin_update on public.appointments
for update to authenticated
using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or practitioner_id = public.fn_my_practitioner_id()
)
with check (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or practitioner_id = public.fn_my_practitioner_id()
);

-- --- tasks: linked to me via the contact's most recent appointment,
--     or via the appointment id stored in metadata. System tasks
--     (no contact, no appointment id) match neither rule: owner only.
drop policy if exists tasks_admin_select on public.tasks;
create policy tasks_admin_select on public.tasks
for select to authenticated using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or (select a.practitioner_id
      from public.appointments a
      where a.contact_id = tasks.contact_id
      order by a.starts_at desc nulls last, a.id desc
      limit 1) = public.fn_my_practitioner_id()
  or exists (select 1 from public.appointments a
             where a.practitioner_id = public.fn_my_practitioner_id()
               and (tasks.metadata ->> 'appointment_id') ~ '^[0-9]+$'
               and a.id = (tasks.metadata ->> 'appointment_id')::bigint)
);

drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks
for update to authenticated
using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or (select a.practitioner_id
      from public.appointments a
      where a.contact_id = tasks.contact_id
      order by a.starts_at desc nulls last, a.id desc
      limit 1) = public.fn_my_practitioner_id()
  or exists (select 1 from public.appointments a
             where a.practitioner_id = public.fn_my_practitioner_id()
               and (tasks.metadata ->> 'appointment_id') ~ '^[0-9]+$'
               and a.id = (tasks.metadata ->> 'appointment_id')::bigint)
)
with check (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or (select a.practitioner_id
      from public.appointments a
      where a.contact_id = tasks.contact_id
      order by a.starts_at desc nulls last, a.id desc
      limit 1) = public.fn_my_practitioner_id()
  or exists (select 1 from public.appointments a
             where a.practitioner_id = public.fn_my_practitioner_id()
               and (tasks.metadata ->> 'appointment_id') ~ '^[0-9]+$'
               and a.id = (tasks.metadata ->> 'appointment_id')::bigint)
);

-- --- contacts: I have ANY appointment with them ---
-- (The dashboard list still filters to current-only patients via
-- fn_my_patient_ids; this policy is the wider security boundary.)
drop policy if exists contacts_admin_select on public.contacts;
create policy contacts_admin_select on public.contacts
for select to authenticated using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or exists (select 1 from public.appointments a
             where a.contact_id = contacts.id
               and a.practitioner_id = public.fn_my_practitioner_id())
);

-- --- interactions: the contact has ANY appointment with me ---
-- (UPDATE is intentionally NOT changed: the Enquiries "Mark as
-- booked" save updates an interaction whose contact may have no
-- appointments at all, and scoping it would break that save.)
drop policy if exists interactions_admin_select on public.interactions;
create policy interactions_admin_select on public.interactions
for select to authenticated using (
  exists (select 1 from public.admin_users au
          where au.user_id = auth.uid() and au.active and au.role = 'owner')
  or exists (select 1 from public.appointments a
             where a.contact_id = interactions.contact_id
               and a.practitioner_id = public.fn_my_practitioner_id())
);

-- --- practitioner list: any active admin can read it ---
-- (Only added if missing — check pg_policies first. The dashboard
-- reads this table on every login for physio names.)
drop policy if exists practicehub_practitioners_admin_select
  on public.practicehub_practitioners;
create policy practicehub_practitioners_admin_select
  on public.practicehub_practitioners
  for select to authenticated using (
    exists (select 1 from public.admin_users au
            where au.user_id = auth.uid() and au.active)
  );

-- ================= VERIFY (run after applying) ====================
-- select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'admin_users'
--   and column_name = 'practitioner_id';
-- select proname from pg_proc
--   where proname in ('fn_my_practitioner_id','fn_my_patient_ids','fn_patient_history');
-- select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public'
--   and tablename in ('appointments','tasks','contacts','interactions','practicehub_practitioners')
--   order by tablename, cmd;

-- ================= ROLLBACK (only if reverting) ====================
-- Restore the old active-admin-only policies:
--
-- drop policy if exists appointments_admin_select on public.appointments;
-- create policy appointments_admin_select on public.appointments
-- for select to authenticated using (
--   exists (select 1 from public.admin_users au
--           where au.user_id = auth.uid() and au.active));
-- drop policy if exists appointments_admin_update on public.appointments;
-- create policy appointments_admin_update on public.appointments
-- for update to authenticated
-- using (exists (select 1 from public.admin_users au
--                where au.user_id = auth.uid() and au.active))
-- with check (exists (select 1 from public.admin_users au
--                     where au.user_id = auth.uid() and au.active));
-- drop policy if exists tasks_admin_select on public.tasks;
-- create policy tasks_admin_select on public.tasks
-- for select to authenticated using (
--   exists (select 1 from public.admin_users au
--           where au.user_id = auth.uid() and au.active));
-- drop policy if exists tasks_admin_update on public.tasks;
-- create policy tasks_admin_update on public.tasks
-- for update to authenticated
-- using (exists (select 1 from public.admin_users au
--                where au.user_id = auth.uid() and au.active))
-- with check (exists (select 1 from public.admin_users au
--                     where au.user_id = auth.uid() and au.active));
-- drop policy if exists contacts_admin_select on public.contacts;
-- create policy contacts_admin_select on public.contacts
-- for select to authenticated using (
--   exists (select 1 from public.admin_users au
--           where au.user_id = auth.uid() and au.active));
-- drop policy if exists interactions_admin_select on public.interactions;
-- create policy interactions_admin_select on public.interactions
-- for select to authenticated using (
--   exists (select 1 from public.admin_users au
--           where au.user_id = auth.uid() and au.active));
-- drop policy if exists practicehub_practitioners_admin_select
--   on public.practicehub_practitioners;
-- To unmap everyone: update public.admin_users set practitioner_id = null;
-- To remove the column: alter table public.admin_users drop column practitioner_id;
-- To remove the helpers: drop function public.fn_patient_history(bigint);
--   drop function public.fn_my_patient_ids();
--   drop function public.fn_my_practitioner_id();
