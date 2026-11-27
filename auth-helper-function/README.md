# auth-helper Edge Function (FM Physio)

Public pre-login helper for the dashboard's forgot-password screen.
**JWT verification stays OFF** — callers are logged out, so there is no
token to verify (same as the ai-assistant function; opposite of the
owner-only admin-users function).

## Action (POST JSON, no auth header needed)

- `account_exists` `{email}` → `{ok: true, exists: true/false}` — checks
  whether the email is a registered Auth user (service-role Admin API).
  It returns only true/false for the single email asked about — never
  emails, names or any other user data.

## Deploy

Supabase Dashboard → Edge Functions → create function `auth-helper` →
paste `index.ts` → Deploy. JWT verification OFF. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided by the platform.

Function URL:
`https://qyvkseltcebgkojmmuno.supabase.co/functions/v1/auth-helper`

## How the dashboard uses it

Forgot-password screen: call `account_exists` with the typed email first.
- `exists: false` → show "No account exists for this email — please
  contact the owner." and send nothing.
- `exists: true` → send the reset link with `resetPasswordForEmail`
  as usual.

No SQL setup is needed for this function.
