# My Work — physio scoping SQL

One file: `setup.sql`. Run it in the Supabase Dashboard SQL Editor
(project `qyvkseltcebgkojmmuno`), top to bottom, as the project owner.

## Order

1. **Section A** (column + grants) — before redeploying the
   `admin-users` Edge Function. `set_practitioner` updates
   `admin_users.practitioner_id`, so the column must exist first.
2. **Section B** (helpers + RPCs) — before the dashboard My Work
   pages can load patient lists.
3. **Section C** (RLS policies) — before granting any `my-*` page to
   a physio. Until C runs, every active admin still sees everything.

Before applying, dump the current policies for rollback (query is at
the top of `setup.sql`). The rollback statements are at the bottom.

## What it creates

- `admin_users.practitioner_id` (integer, nullable) — the physio a
  login belongs to. NULL = owner or unmapped.
- `fn_my_practitioner_id()` — caller's practitioner id (SECURITY
  DEFINER).
- `fn_my_patient_ids()` — contact ids whose most recent appointment
  is with the caller (SECURITY DEFINER).
- `fn_patient_history(contact_id)` — full appointment history with
  practitioner names, for the owner or a physio linked to that
  patient (SECURITY DEFINER).
- New SELECT/UPDATE policies on `appointments`, `tasks`,
  `contacts`, `interactions` + a SELECT policy on
  `practicehub_practitioners`. Owner keeps full access everywhere.
  INSERT policies are unchanged.

## What it does NOT do

- It does not change `user_page_access`, `ai_settings`, the
  `ai-assistant` function, or any n8n workflow.
- It does not map any user to a physio — the owner does that in
  Users & Access after the `admin-users` function is redeployed.
- Unmapped non-owner users see empty data after Section C until
  they are mapped. That includes the temporary logins.

## Verify after applying

Run the three queries in the VERIFY block at the end of `setup.sql`:
column exists, 3 functions exist, policies listed per table.
