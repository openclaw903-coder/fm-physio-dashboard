// FM Physio AI Assistant — Supabase Edge Function (Deno)
// One function, four actions: status / save_key / delete_key / chat.
//
// SECURITY MODEL (the whole point of this function):
// - The provider API key is NEVER returned to the browser. It lives in
//   Supabase Vault (vault.decrypted_secrets) and is read server-side only,
//   via the SECURITY DEFINER function fm_get_ai_secret (see setup.sql).
// - Provider/model/base_url live in public.ai_settings
//   with RLS enabled and NO policies — only the service role can touch it.
//   (No PIN hash: the owner asked to skip the PIN gate on 25 Nov.)
// - The browser only ever talks to this function. It never calls a provider
//   directly and never stores a key (no localStorage key flow).
// - NOTE (25 Nov, user's call): NO owner PIN for now — the owner asked to skip
//   it. Anyone holding the dashboard link could open Settings and replace the
//   key (they still could never READ the saved key). Add a PIN gate later if
//   the link is shared more widely.
// - CORS allows only the Vercel dashboard origin and the Muse preview origin.
// - Best-effort per-IP rate limit (20 req/min) so the key cannot be drained
//   by hammering the public endpoint.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const ALLOWED_ORIGINS = new Set([
  "https://fm-physio-dashboard-iota.vercel.app",
  "https://muse.ai",
]);

type ProviderKind = "openai" | "anthropic" | "gemini";
const PROVIDERS: Record<string, { base: string; defaultModel: string; kind: ProviderKind }> = {
  openai: { base: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", kind: "openai" },
  anthropic: { base: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514", kind: "anthropic" },
  gemini: { base: "https://generativelanguage.googleapis.com", defaultModel: "gemini-2.0-flash", kind: "gemini" },
  groq: { base: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-20b", kind: "openai" },
  openrouter: { base: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini", kind: "openai" },
  mistral: { base: "https://api.mistral.ai/v1", defaultModel: "mistral-small-latest", kind: "openai" },
  custom: { base: "", defaultModel: "", kind: "openai" },
};

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://fm-physio-dashboard-iota.vercel.app",
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

async function getSettings() {
  const { data } = await supabase.from("ai_settings").select("*").eq("id", 1).maybeSingle();
  return data ?? null;
}

async function getKey(): Promise<string | null> {
  const { data, error } = await supabase.rpc("fm_get_ai_secret", { p_name: "fm_ai_provider_key" });
  if (error) {
    console.error("fm_get_ai_secret error", error);
    return null;
  }
  return (data as string | null) ?? null;
}

// Live grounding: fresh counts straight from Supabase, so answers are real.
async function liveContext(): Promise<string> {
  try {
    const [contacts, tasks, appts, inter, openTasks] = await Promise.all([
      supabase.from("contacts").select("id", { count: "exact", head: true }),
      supabase.from("tasks").select("id", { count: "exact", head: true }),
      supabase.from("appointments").select("id", { count: "exact", head: true }),
      supabase.from("interactions").select("id", { count: "exact", head: true }),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("status", "open"),
    ]);
    // Today in the clinic's timezone (Europe/London; GMT in winter = UTC).
    const londonToday = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const { data: todayAppts } = await supabase
      .from("appointments")
      .select("status")
      .gte("starts_at", `${londonToday}T00:00:00Z`)
      .lt("starts_at", `${londonToday}T23:59:59Z`);
    const todayByStatus: Record<string, number> = {};
    for (const a of todayAppts ?? []) todayByStatus[a.status] = (todayByStatus[a.status] ?? 0) + 1;
    const todayTotal = todayAppts?.length ?? 0;
    const { data: perf } = await supabase
      .from("dashboard_monthly_performance")
      .select("report_month, attended, no_shows, cancellations")
      .order("report_month", { ascending: false })
      .limit(3);
    const lines = [
      `Live clinic data (Supabase, just now): contacts ${contacts.count ?? "?"}, tasks ${tasks.count ?? "?"} (${openTasks.count ?? "?"} open), appointments ${appts.count ?? "?"}, AI interactions ${inter.count ?? "?"}.`,
      `Today (${londonToday}, clinic time): ${todayTotal} appointments` +
        (todayTotal
          ? ` — ${Object.entries(todayByStatus).map(([s, n]) => `${s} ${n}`).join(", ")}.`
          : "."),
      perf?.length
        ? `Monthly: ${perf.map((r) => `${r.report_month}: attended ${r.attended}, no-shows ${r.no_shows}, cancellations ${r.cancellations}`).join("; ")}.`
        : "",
      "Rules: answer ONLY from this data. Revenue, payments, deposits, AI cost, packages, NPS and diary fill are NOT in Supabase — say 'No data yet' for those, never invent a figure. Keep answers short.",
    ].filter(Boolean);
    return lines.join("\n");
  } catch (e) {
    console.error("liveContext", e);
    return "Live data unavailable right now — say so and do not invent numbers.";
  }
}

async function callProvider(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  system: string,
  userText: string,
): Promise<string> {
  const p = PROVIDERS[provider] ?? PROVIDERS.custom;
  const m = model || p.defaultModel;
  if (p.kind === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const j = await r.json();
    return j.content?.[0]?.text ?? "No answer.";
  }
  if (p.kind === "gemini") {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: `${system}\n\n${userText}` }] }] }),
      },
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "No answer.";
  }
  const base = provider === "custom" ? baseUrl.replace(/\/$/, "") : p.base;
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: m,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Provider ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "No answer.";
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
    const s = await getSettings();
    return json(req, {
      configured: !!s?.provider,
      provider: s?.provider ?? null,
      model: s?.model ?? null,
      updated_at: s?.updated_at ?? null,
    });
  }

  if (body.action === "save_key") {
    const provider = String(body.provider ?? "");
    const model = String(body.model ?? "");
    const base_url = String(body.base_url ?? "");
    const api_key = String(body.api_key ?? "");
    if (!PROVIDERS[provider]) return json(req, { error: "Unknown provider." }, 400);
    if (!api_key || api_key.length < 8) return json(req, { error: "Enter a valid API key." }, 400);
    if (provider === "custom" && !base_url) return json(req, { error: "Custom needs a base URL." }, 400);

    // Key -> Vault (server-side only). Never stored in ai_settings, never returned.
    const { error: rpcErr } = await supabase.rpc("fm_save_ai_secret", {
      p_name: "fm_ai_provider_key",
      p_secret: api_key,
    });
    if (rpcErr) {
      console.error(rpcErr);
      return json(req, { error: "Could not save the key. Run the SQL setup first." }, 500);
    }
    const { error } = await supabase.from("ai_settings").upsert({
      id: 1,
      provider,
      model: model || PROVIDERS[provider].defaultModel,
      base_url: base_url || null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error(error);
      return json(req, { error: "Could not save settings." }, 500);
    }
    return json(req, { ok: true, provider, model: model || PROVIDERS[provider].defaultModel });
  }

  if (body.action === "delete_key") {
    // Deletes the Vault secret AND the settings row, so the assistant is
    // back to "Not configured". The key is never returned to the browser.
    const { error } = await supabase.rpc("fm_delete_ai_secret");
    if (error) {
      console.error(error);
      return json(req, { error: "Could not delete the key." }, 500);
    }
    return json(req, { ok: true, configured: false });
  }

  if (body.action === "chat") {
    const s = await getSettings();
    if (!s?.provider) {
      return json(req, {
        reply: "AI is not set up yet — the owner can add a provider key in Settings (gear icon).",
      });
    }
    const key = await getKey();
    if (!key) {
      return json(req, { reply: "No provider key is saved — the owner can add one in Settings." });
    }
    const text = String(body.message ?? "").slice(0, 2000);
    if (!text.trim()) return json(req, { error: "Empty message." }, 400);
    try {
      const system = await liveContext();
      const reply = await callProvider(s.provider, s.model, s.base_url ?? "", key, system, text);
      return json(req, { reply });
    } catch (e) {
      console.error(e);
      return json(req, { reply: "The AI provider returned an error — check the saved key in Settings." });
    }
  }

  return json(req, { error: "Unknown action." }, 400);
});
