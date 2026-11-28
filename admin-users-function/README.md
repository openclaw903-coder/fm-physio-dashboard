# admin-users Edge Function (FM Physio)

Owner-only user management for the dashboard. Stuart (owner) is the only
account that can call it; everyone else gets `403 owner only`.

## Actions (POST JSON, Authorization: Bearer <owner access token>)

- `list_users` — all `admin_users` rows + each user's email (from Auth) and
  allowed pages.
- `invite` `{email, display_name, pages[]}` — sends the Supabase invite email
  (the user sets their own password from the link), creates the `admin_users`
  row (`role: 'user'`, `active: true`) and the `user_page_access` rows.
- `set_pages` `{user_id, pages[]}` — replaces a user's allowed pages.
- `set_practitioner` `{user_id, practitioner_id|null}` — links a user
  login to a physio (their My Work pages show only that physio's data).
  `practitioner_id` must be a `practicehub_practitioners` id (1 Stuart,
  7 Kate, 8 Lucy, 9 Arek, 11 Ethan, 12 Aadyaa) — or, as a safety net, an
  id that appears in `appointments` but is missing from that table (the
  dashboard offers those too); `null` removes the link.
  The owner cannot be mapped. Requires the `practitioner_id` column on
  `admin_users` — run `../my-work-sql/setup.sql` Section A first.
- `set_active` `{user_id, active}` — deactivate (remove access) / reactivate.
- `delete_user` `{user_id}` — permanently deletes the Auth user + admin row.
  Page-access rows cascade from the Auth user delete.

The owner can never deactivate or delete themself (or the owner role).

## Deploy

Supabase Dashboard → Edge Functions → create function `admin-users` → paste
`index.ts` → Deploy. JWT verification stays **ON** (default). `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform.

Function URL:
`https://qyvkseltcebgkojmmuno.supabase.co/functions/v1/admin-users`

## Prerequisite — Site URL (administrator)

The invite email link points at the Auth Site URL. Until the administrator
sets it to `https://fm-physio-dashboard-zol1.vercel.app` (Authentication →
URL Configuration → Site URL, plus the same URL under Redirect URLs), the
invite link lands on `http://localhost:3000` and breaks. Fix that before the
first invite goes out.

## SQL (run first)

`setup.sql` in this folder: `role` on `admin_users` (`owner`/`user`),
`user_page_access` table + RLS (owner-or-self read, owner-only write),
grants for `authenticated` and `service_role`, and a backfill giving every
existing admin user all 16 pages.

My Work pages (`my-appointments`, `my-patients`, `my-tasks`) are part of
the page list; they are granted through the same tick UI as the other
pages. New users still get NO pages by default. Never grant the `ai`
page to a physio — the AI assistant reads everything via service_role
and has no caller identity, so it stays owner-only.
