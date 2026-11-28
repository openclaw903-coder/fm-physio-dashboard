// FM Physio AI call costs — Supabase Edge Function (Deno)
// One function, six actions: status / save_retell_key / save_vapi_key /
// delete_retell_key / delete_vapi_key / costs.
//
// SECURITY MODEL (same as ai-assistant — the whole point):
// - The Retell + Vapi keys are NEVER returned to the browser. They live in
//   Supabase Vault (vault.decrypted_secrets) and are read server-side only,
//   via the SECURITY DEFINER function fm_get_cost_secret (see setup.sql).
// - Provider/key state lives in public.ai_cost_settings with RLS enabled
//   and NO policies — only the service role (Edge Function) can touch it.
// - The browser only ever talks to this function. It never calls Retell or
//   Vapi directly and never stores a key (no localStorage key flow).
// - NO owner PIN for now — same call as the AI assistant (25 Nov): anyone
//   holding the dashboard link could open Settings and replace a key (they
//   still could never READ a saved key). Add a PIN gate later if the link
//   is shared more widely.
// - CORS allows only the dashboard origins (Vercel, GitHub Pages) and the
//   Muse preview origin.
// - Best-effort per-IP rate limit (20 req/min) so the keys cannot be drained
//   by hammering the public endpoint.
// - JWT verification is OFF (same reason as ai-assistant: the dashboard
//   calls this from the browser with no Supabase Auth token on the request).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const ALLOWED_ORIGINS = new Set([
  "https://fm-physio-dashboard-iota.vercel.app",
  "https://fm-physio-dashboard-zol1.vercel.app",
  "https://openclaw903-coder.github.io",
  "https://muse.ai",
]);

// Retell agent ids — identifiers, NOT secrets (from the Retell audit,
// 22 Nov 2026; the dashboard's own booked classification maps these same
// agents: after-hours = Inbound Calling, discharge + Mona = Outbound).
const RETELL_AFTER_HOURS = "agent_b254a84319777593f4aef21fb8";
const RETELL_DISCHARGE = "agent_e1df7cc31b02cab48208f43969";
const RETELL_MONA = "agent_d1974fda557e3e617c41834eac";
const RETELL_AGENT_TO_CARD: Record<string, "in" | "out"> = {
  [RETELL_AFTER_HOURS]: "in",
  [RETELL_DISCHARGE]: "out",
  [RETELL_MONA]: "out",
};

// Vapi: no assistant id is recorded anywhere in the dashboard (the booked
// classification keys off provider === "vapi" only), so every Vapi call in
// the range counts as Inbound Chat. This org runs a single Vapi assistant
// (A1 inbound chat). If the org ever runs a second Vapi assistant, add an
// assistantId filter here and a matching Settings field.
const MAX_CALLS = 1000; // per provider, per costs call
const PROVIDER_TIMEOUT_MS = 45000;

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://fm-physio-dashboard-zol1.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// Best-effort per-IP rate limit (in-memory, 20 req/min).
const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.reset) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  e.n += 1;
  return e.n > 20;
}

const SECRET_NAMES = { retell: "fm_retell_api_key", vapi: "fm_vapi_api_key" } as const;
type ProviderKey = keyof typeof SECRET_NAMES;

async function getCostSettings(): Promise<Record<string, boolean>> {
  const { data } = await supabase.from("ai_cost_settings").select("provider, configured");
  const out: Record<string, boolean> = {};
  for (const row of data ?? []) out[row.provider] = !!row.configured;
  return out;
}

async function getCostKey(provider: ProviderKey): Promise<string | null> {
  const { data, error } = await supabase.rpc("fm_get_cost_secret", { p_name: SECRET_NAMES[provider] });
  if (error) {
    console.error("fm_get_cost_secret error", error);
    return null;
  }
  return (data as string | null) ?? null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Agg = { calls: number; minutes: number; cost: number };
function zeroAgg(): Agg {
  return { calls: 0, minutes: 0, cost: 0 };
}
function aggregate(
  calls: unknown[],
  secondsFn: (c: Record<string, unknown>) => number,
  usdFn: (c: Record<string, unknown>) => number,
): Agg & { seconds: number } {
  let seconds = 0;
  let cost = 0;
  for (const raw of calls) {
    const c = raw as Record<string, unknown>;
    const s = secondsFn(c);
    const u = usdFn(c);
    if (Number.isFinite(s) && s > 0) seconds += s;
    if (Number.isFinite(u) && u > 0) cost += u;
  }
  return { calls: calls.length, seconds, minutes: round1(seconds / 60), cost: round2(cost) };
}

// ---------- Retell ----------
// POST https://api.retellai.com/v3/list-calls — current list endpoint
// (v2 list-calls is legacy/deprecated per Retell's deprecation notice).
// Request: { filter_criteria: { agent_id: [...], start_timestamp:
// { lower_threshold: <ms>, upper_threshold: <ms> } }, limit, sort_order,
// pagination_key }. Response: call objects (bare array, or an object with
// an `items` array — both handled; an unrecognised shape is a loud error,
// never silent zeros). Docs: https://docs.retellai.com/api-references/overview
// (auth + base URL) and the v3 filter shape from the official Retell SDK
// (filter_criteria.agent_id + start_timestamp range, ms).
// Per call: duration_ms (ms) and call_cost.combined_cost (CENTS) — fall
// back to end_timestamp - start_timestamp, and to the sum of
// call_cost.product_costs[].cost (also cents).
function retellSeconds(c: Record<string, unknown>): number {
  if (typeof c.duration_ms === "number") return c.duration_ms / 1000;
  if (typeof c.start_timestamp === "number" && typeof c.end_timestamp === "number") {
    return Math.max(0, (c.end_timestamp - c.start_timestamp) / 1000);
  }
  return 0;
}
function retellUsd(c: Record<string, unknown>): number {
  const cc = c.call_cost as Record<string, unknown> | null;
  if (!cc) return 0;
  if (typeof cc.combined_cost === "number") return cc.combined_cost / 100;
  if (Array.isArray(cc.product_costs)) {
    return (cc.product_costs as Record<string, unknown>[]).reduce(
      (s: number, p: Record<string, unknown>) => s + (typeof p.cost === "number" ? p.cost : 0),
      0,
    ) / 100;
  }
  return 0;
}

async function fetchRetellCalls(
  key: string,
  fromISO: string | null,
  toISO: string | null,
): Promise<{ calls: unknown[]; truncated: boolean }> {
  const calls: unknown[] = [];
  let paginationKey: string | null = null;
  let truncated = false;
  let pages = 0;
  while (calls.length < MAX_CALLS && pages < 10) {
    pages += 1;
    const filter: Record<string, unknown> = {
      agent_id: [RETELL_AFTER_HOURS, RETELL_DISCHARGE, RETELL_MONA],
    };
    if (fromISO || toISO) {
      const range: Record<string, number> = {};
      if (fromISO) range.lower_threshold = Date.parse(fromISO);
      if (toISO) range.upper_threshold = Date.parse(toISO);
      filter.start_timestamp = range;
    }
    const body: Record<string, unknown> = {
      filter_criteria: filter,
      limit: Math.min(1000, MAX_CALLS - calls.length),
      sort_order: "descending",
    };
    if (paginationKey) body.pagination_key = paginationKey;
    const r = await fetch("https://api.retellai.com/v3/list-calls", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!r.ok) {
      const err = new Error(`Retell list-calls HTTP ${r.status}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const items = Array.isArray(j)
      ? j
      : Array.isArray((j as Record<string, unknown>).items)
        ? ((j as Record<string, unknown>).items as unknown[])
        : Array.isArray((j as Record<string, unknown>).calls)
          ? ((j as Record<string, unknown>).calls as unknown[])
          : null;
    if (!items) throw new Error("Unexpected Retell list-calls response shape");
    calls.push(...items);
    const nextKey =
      !Array.isArray(j) && typeof (j as Record<string, unknown>).pagination_key === "string"
        ? ((j as Record<string, unknown>).pagination_key as string)
        : null;
    // No cursor and a full page means there may be more we cannot reach.
    if (items.length === 0) break;
    if (!nextKey) {
      if (items.length >= (body.limit as number)) truncated = true;
      break;
    }
    paginationKey = nextKey;
  }
  if (calls.length >= MAX_CALLS) truncated = true;
  return { calls: calls.slice(0, MAX_CALLS), truncated };
}

// ---------- Vapi ----------
// GET https://api.vapi.ai/call?assistantId&limit&createdAtGe&createdAtLe…
// Auth: private key as Bearer. Response: array of call objects.
// Per call: cost (USD, number); duration = endedAt - startedAt (ISO).
// Docs: https://docs.vapi.ai/api-reference/calls/list
// Pagination: limit-based only (no cursor) — walk back with createdAtLt
// (see the bvapi note: repeat with --created-at-lt to go further back).
function vapiSeconds(c: Record<string, unknown>): number {
  if (typeof c.startedAt === "string" && typeof c.endedAt === "string") {
    const s = (Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 1000;
    return Number.isFinite(s) && s > 0 ? s : 0;
  }
  return 0;
}
function vapiUsd(c: Record<string, unknown>): number {
  if (typeof c.cost === "number") return c.cost;
  if (c.costs && typeof c.costs === "object") {
    return (Object.values(c.costs as Record<string, unknown>) as unknown[]).reduce(
      (s: number, v: unknown) => s + (typeof v === "number" ? v : 0),
      0,
    );
  }
  return 0;
}

async function fetchVapiCalls(
  key: string,
  fromISO: string | null,
  toISO: string | null,
): Promise<{ calls: unknown[]; truncated: boolean; assistantIds: string[] }> {
  const calls: unknown[] = [];
  const seen = new Set<string>();
  let lt: string | null = null;
  let truncated = false;
  let pages = 0;
  while (calls.length < MAX_CALLS && pages < 10) {
    pages += 1;
    const q = new URLSearchParams();
    q.set("limit", String(Math.min(100, MAX_CALLS - calls.length)));
    if (fromISO) q.set("createdAtGe", fromISO);
    if (toISO) q.set("createdAtLe", toISO);
    if (lt) q.set("createdAtLt", lt);
    const r = await fetch("https://api.vapi.ai/call?" + q.toString(), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!r.ok) {
      const err = new Error(`Vapi list-calls HTTP ${r.status}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const items = Array.isArray(j)
      ? j
      : Array.isArray((j as Record<string, unknown>).calls)
        ? ((j as Record<string, unknown>).calls as unknown[])
        : null;
    if (!items) throw new Error("Unexpected Vapi list-calls response shape");
    if (items.length === 0) break;
    let added = 0;
    for (const raw of items) {
      const c = raw as Record<string, unknown>;
      const id = typeof c.id === "string" ? c.id : "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      calls.push(c);
      added += 1;
    }
    if (added === 0) break; // cursor stopped moving — avoid an infinite loop
    const oldest = (items[items.length - 1] as Record<string, unknown>).createdAt;
    if (items.length < 100 || typeof oldest !== "string" || oldest === lt) break;
    lt = oldest;
  }
  if (calls.length >= MAX_CALLS) truncated = true;
  const assistantIds = [...new Set(
    calls.map((raw) => (raw as Record<string, unknown>).assistantId).filter((x): x is string => typeof x === "string"),
  )];
  return { calls: calls.slice(0, MAX_CALLS), truncated, assistantIds };
}

function providerError(e: unknown, provider: string): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    return `The ${provider} key was rejected — check the saved key in Settings.`;
  }
  if (status === 429) return `${provider} rate limit — try again in a minute.`;
  if ((e as Error)?.name === "TimeoutError") return `${provider} timed out — try again.`;
  if (status) return `${provider} error (HTTP ${status}) — try again.`;
  return `${provider} error — ${(e as Error)?.message ?? "try again."}`;
}

function validDateParam(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "__invalid__";
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return json(req, { error: "Too many requests — try again in a minute." }, 429);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Bad request." }, 400);
  }

  if (body.action === "status") {
    const s = await getCostSettings();
    return json(req, {
      retell_configured: !!s.retell,
      vapi_configured: !!s.vapi,
    });
  }

  if (body.action === "save_retell_key" || body.action === "save_vapi_key") {
    const provider: ProviderKey = body.action === "save_retell_key" ? "retell" : "vapi";
    const key = String(body.key ?? "");
    if (!key || key.length < 8) return json(req, { error: "Enter a valid API key." }, 400);
    // Key -> Vault (server-side only). Never stored in ai_cost_settings,
    // never returned.
    const { error: rpcErr } = await supabase.rpc("fm_save_cost_secret", {
      p_name: SECRET_NAMES[provider],
      p_secret: key,
    });
    if (rpcErr) {
      console.error(rpcErr);
      return json(req, { error: "Could not save the key. Run the SQL setup first." }, 500);
    }
    const { error } = await supabase.from("ai_cost_settings").upsert({
      provider,
      configured: true,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error(error);
      return json(req, { error: "Could not save settings." }, 500);
    }
    return json(req, { ok: true, provider });
  }

  if (body.action === "delete_retell_key" || body.action === "delete_vapi_key") {
    const provider: ProviderKey = body.action === "delete_retell_key" ? "retell" : "vapi";
    const { error } = await supabase.rpc("fm_delete_cost_secret", {
      p_name: SECRET_NAMES[provider],
      p_provider: provider,
    });
    if (error) {
      console.error(error);
      return json(req, { error: "Could not delete the key." }, 500);
    }
    return json(req, { ok: true, provider, configured: false });
  }

  if (body.action === "costs") {
    const from = validDateParam(body.from);
    const to = validDateParam(body.to);
    if (from === "__invalid__" || to === "__invalid__") {
      return json(req, { error: "from/to must be YYYY-MM-DD dates." }, 400);
    }
    if (from && to && from > to) {
      return json(req, { error: "from must not be after to." }, 400);
    }
    // Day bounds: from 00:00:00Z, to 23:59:59.999Z (inclusive end of day).
    const fromISO = from ? `${from}T00:00:00.000Z` : null;
    const toISO = to ? `${to}T23:59:59.999Z` : null;

    const [retellKey, vapiKey] = await Promise.all([
      getCostKey("retell"),
      getCostKey("vapi"),
    ]);

    const agents: Record<"in" | "out" | "chat", Agg> = {
      in: zeroAgg(),
      out: zeroAgg(),
      chat: zeroAgg(),
    };
    const providers: Record<string, Record<string, unknown>> = {};
    let truncated = false;
    // Raw (unrounded) sums for the totals — totals must not double-round
    // the per-agent 0.1-minute figures.
    let retellSecondsTotal = 0;
    let retellCostTotal = 0;
    let vapiSecondsTotal = 0;
    let vapiCostTotal = 0;

    // Retell — one provider failure must not fail the whole call.
    if (!retellKey) {
      providers.retell = { configured: false, ...zeroAgg() };
    } else {
      try {
        const { calls, truncated: t } = await fetchRetellCalls(retellKey, fromISO, toISO);
        truncated = truncated || t;
        const byCard: Record<"in" | "out", unknown[]> = { in: [], out: [] };
        for (const raw of calls) {
          const card = RETELL_AGENT_TO_CARD[(raw as Record<string, unknown>).agent_id as string];
          if (card) byCard[card].push(raw);
        }
        const aIn = aggregate(byCard.in, retellSeconds, retellUsd);
        const aOut = aggregate(byCard.out, retellSeconds, retellUsd);
        agents.in = { calls: aIn.calls, minutes: aIn.minutes, cost: aIn.cost };
        agents.out = { calls: aOut.calls, minutes: aOut.minutes, cost: aOut.cost };
        providers.retell = { configured: true, calls: calls.length, truncated: t };
        retellSecondsTotal = aIn.seconds + aOut.seconds;
        retellCostTotal = aIn.cost + aOut.cost;
      } catch (e) {
        console.error("retell costs", e);
        providers.retell = { configured: true, error: providerError(e, "Retell"), ...zeroAgg() };
      }
    }

    // Vapi — every call in range counts as Inbound Chat (see note above).
    if (!vapiKey) {
      providers.vapi = { configured: false, ...zeroAgg() };
    } else {
      try {
        const { calls, truncated: t, assistantIds } = await fetchVapiCalls(vapiKey, fromISO, toISO);
        truncated = truncated || t;
        const aChat = aggregate(calls, vapiSeconds, vapiUsd);
        agents.chat = { calls: aChat.calls, minutes: aChat.minutes, cost: aChat.cost };
        providers.vapi = { configured: true, calls: calls.length, truncated: t, assistant_ids: assistantIds };
        vapiSecondsTotal = aChat.seconds;
        vapiCostTotal = aChat.cost;
      } catch (e) {
        console.error("vapi costs", e);
        providers.vapi = { configured: true, error: providerError(e, "Vapi"), ...zeroAgg() };
      }
    }

    const totals: Agg = {
      calls: agents.in.calls + agents.out.calls + agents.chat.calls,
      minutes: round1((retellSecondsTotal + vapiSecondsTotal) / 60),
      cost: round2(retellCostTotal + vapiCostTotal),
    };
    return json(req, {
      ok: true,
      from: from ?? null,
      to: to ?? null,
      agents,
      totals,
      providers,
      truncated,
    });
  }

  return json(req, { error: "Unknown action." }, 400);
});
