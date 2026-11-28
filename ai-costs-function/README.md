# FM Physio AI call costs — Retell + Vapi, direct from their APIs

Owner adds the Retell API key and the Vapi **private** key from the
dashboard Settings; the keys are never exposed and the costs come live
from Retell/Vapi — never invented, never hardcoded.

## Pieces

- `setup.sql` — run ONCE in Supabase Dashboard → SQL Editor (project
  `qyvkseltcebgkojmmuno`). Creates Vault extension, `ai_cost_settings`
  table (RLS on, no policies = client can never read it), and the
  `fm_save_cost_secret` / `fm_get_cost_secret` / `fm_delete_cost_secret`
  helpers (service_role only).
- `index.ts` — the Edge Function `ai-costs`. Actions: `status`,
  `save_retell_key`, `save_vapi_key`, `delete_retell_key`,
  `delete_vapi_key`, `costs`. Reads both keys from Vault server-side only,
  calls the Retell + Vapi list-calls APIs, aggregates minutes + cost per
  agent and in total. URL once deployed:
  `https://qyvkseltcebgkojmmuno.supabase.co/functions/v1/ai-costs`

## Deploy (Supabase Dashboard UI — no access token needed)

1. Run `setup.sql` in SQL Editor.
2. Dashboard → Edge Functions → Create a new function → name `ai-costs`
   → paste `index.ts` → Deploy.
3. **Verify JWT verification is OFF** on the function's Settings page
   (the dashboard calls it from the browser with no Auth token — with JWT
   ON every call 401s, same as `ai-assistant`).
4. Test: `curl -X POST <url> -H 'Content-Type: application/json' -d '{"action":"status"}'`
   → `{"retell_configured":false,"vapi_configured":false}` before any key
   is saved.

## Owner flow (in the dashboard)

AI Assistant panel → gear (Settings) → "AI call costs" section → paste
the **Retell API key** (Retell dashboard → API Keys) and/or the **Vapi
private key** (Vapi dashboard → API Keys → Private API Keys) → Save.
The key field clears after saving; the key is never shown back, never
stored in the browser, never baked into the page. Delete is two-tap
confirm, like the AI provider key.

## What the dashboard shows

- AI Agents page, per agent card: minutes + cost + call count for the
  current date filter (e.g. "42 min · $3.18", label "Cost · 12 calls").
  An agent whose provider key is missing shows "Add key in Settings",
  never a fake zero. The page's "Total cost" / "Minutes used" KPIs show
  the combined totals.
- Overview AI panel: the combined total only ("AI call costs · 42 min ·
  $3.18 · 12 calls · All dates") — never the per-agent breakdown.
- All costs are USD ($), never £. Minutes are whole minutes on display;
  the JSON keeps 1 decimal.

## Verified API facts (checked 28 Nov 2026 — do not invent replacements)

| | Retell | Vapi |
|---|---|---|
| List calls | `POST https://api.retellai.com/v3/list-calls` (v3 is current; v2 list-calls is legacy/deprecated per Retell's deprecation notice) | `GET https://api.vapi.ai/call` |
| Auth | `Authorization: Bearer <key>` (single API key, no public/private split) | `Authorization: Bearer <private key>` (public key = client SDK only, 401 on the REST API) |
| Filters | body `{ filter_criteria: { agent_id: [...], start_timestamp: { lower_threshold: <ms>, upper_threshold: <ms> } }, limit (max 1000), sort_order, pagination_key }` | query `assistantId`, `limit` (default 100), `createdAtGe` / `createdAtLe` (ISO 8601, inclusive), `createdAtGt` / `createdAtLt` |
| Pagination | `pagination_key` cursor in the response | limit-based only, no cursor — walk back with `createdAtLt` = oldest `createdAt` seen |
| Cost field | `call_cost.combined_cost` in **cents** → USD = /100 (fallback: sum of `call_cost.product_costs[].cost`, also cents) | `cost` in **USD** (fallback: sum of the `costs` component object) |
| Duration field | `duration_ms` in ms (fallback: `end_timestamp - start_timestamp`, both ms since epoch) | `endedAt - startedAt` (ISO 8601 strings) |
| Doc URLs | https://docs.retellai.com/api-references/overview (auth + base URL); v3 filter shape from the official Retell SDK (`filter_criteria.agent_id` + `start_timestamp` range) | https://docs.vapi.ai/api-reference/calls/list |

## Known uncertainties (flagged honestly — confirm on first live run)

1. **Retell v3 response envelope.** The docs text does not state outright
   whether `POST /v3/list-calls` returns a bare JSON array or an object
   with an `items` array. The function accepts both (and a `calls` array)
   and fails LOUDLY — the Retell provider returns an error instead of
   silent zeros — if the shape is neither. If the first live `costs` call
   reports a Retell shape error, read the real envelope and adjust the
   one parsing spot in `fetchRetellCalls`.
2. **Retell v3 agent filter key.** The official SDK's filter shape uses
   `filter_criteria.agent_id` (flat string array). One secondary source
   describes a v3 `agent` array of `{agent_id, version}` objects instead.
   The SDK (generated from Retell's OpenAPI spec) wins; if the first live
   call 422s on the filter, try the `agent` shape.
3. **Vapi assistant scope.** No Vapi assistant id is recorded anywhere in
   the dashboard (booked classification keys off provider only), so the
   function lists ALL Vapi calls in the range as Inbound Chat. This org
   runs a single Vapi assistant (A1). The response includes
   `providers.vapi.assistant_ids` (distinct assistant ids seen) so a
   second assistant would be visible immediately.
4. **Retell `duration_ms` on list rows.** Verified as a call-object field
   from Retell's own observability docs; the `end_timestamp -
   start_timestamp` fallback covers rows where it is absent.

## Response shape (`costs`)

```json
{
  "ok": true, "from": "2026-11-22", "to": "2026-11-28",
  "agents": {
    "in":   { "calls": 12, "minutes": 84.5, "cost": 9.31 },
    "out":  { "calls": 5,  "minutes": 31.2, "cost": 3.44 },
    "chat": { "calls": 9,  "minutes": 22.0, "cost": 1.87 }
  },
  "totals": { "calls": 26, "minutes": 137.7, "cost": 14.62 },
  "providers": {
    "retell": { "configured": true, "calls": 17, "truncated": false },
    "vapi":   { "configured": true, "calls": 9, "truncated": false,
                "assistant_ids": ["…"] }
  },
  "truncated": false
}
```

- `minutes` is 1 decimal; `cost` is 2 decimals, USD. A provider with no
  key returns `{ "configured": false, "calls": 0, "minutes": 0, "cost": 0 }`
  and the other provider's numbers still come through. A provider that
  fails returns `{ "configured": true, "error": "…", …zeros }` — the call
  itself still succeeds. `truncated: true` means the 1000-call cap was
  hit for that range (narrow the date filter).
- Agent mapping: `in` = Retell after-hours
  (`agent_b254a84319777593f4aef21fb8`); `out` = Retell discharge
  (`agent_e1df7cc31b02cab48208f43969`) + Mona
  (`agent_d1974fda557e3e617c41834eac`); `chat` = all Vapi calls.

## Reset (owner only, SQL Editor)

```sql
delete from public.ai_cost_settings;
delete from vault.secrets where name in ('fm_retell_api_key', 'fm_vapi_api_key');
```

Note: this project's Vault has NO `vault.delete_secret` function (only
`create_secret` / `update_secret` exist) — delete the secret rows directly
as above (same as `ai-assistant`).
