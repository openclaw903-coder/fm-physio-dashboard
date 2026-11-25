# FM Physio AI Assistant — server-side key setup

Owner adds any provider key from the dashboard itself; the key is never exposed.

## Pieces

- `setup.sql` — run ONCE in Supabase Dashboard → SQL Editor (project
  `qyvkseltcebgkojmmuno`). Creates Vault extension, `ai_settings` table
  (RLS on, no policies = client can never read it), and the
  `fm_save_ai_secret` / `fm_get_ai_secret` helpers (service_role only).
- `index.ts` — the Edge Function `ai-assistant`. Actions: `status`,
  `save_key`, `chat`. Reads the key from Vault server-side only, grounds
  answers in live Supabase counts, calls the configured provider.
  URL once deployed:
  `https://qyvkseltcebgkojmmuno.supabase.co/functions/v1/ai-assistant`

## Deploy (Supabase Dashboard UI — no access token needed)

1. Run `setup.sql` in SQL Editor.
2. Dashboard → Edge Functions → Create a new function → name `ai-assistant`
   → paste `index.ts` → Deploy.
3. Test: `curl -X POST <url> -H 'Content-Type: application/json' -d '{"action":"status"}'`
   → `{"configured":false,...}` before any key is saved.

## Owner flow (in the dashboard)

Settings (gear in the AI panel) → provider → model → API key → Save.
The key field clears after saving; the key is never shown back, never stored
in the browser, never baked into the page.

## Reset (owner only, SQL Editor)

```sql
delete from public.ai_settings where id = 1;
delete from vault.secrets where name = 'fm_ai_provider_key';
```
Note: this project's Vault has NO `vault.delete_secret` function (only
`create_secret` / `update_secret` exist) — delete the secret row directly
as above.
