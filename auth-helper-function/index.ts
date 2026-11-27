// FM Physio — auth-helper Edge Function
// Public pre-login helper. JWT verification stays OFF: callers are logged
// out (forgot-password screen), so there is no token to verify.
// Action: account_exists { email } -> { ok, exists }
// Used by the dashboard forgot-password screen so it can say plainly
// "No account exists for this email — please contact the owner."
// instead of the vague "if an account exists" message. When the account
// exists, the dashboard then sends the reset link as usual.
// The check reads Auth users via the service-role Admin API; it never
// returns emails, names or any user data — only true/false for the
// single email asked about.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://fm-physio-dashboard-zol1.vercel.app",
  "https://openclaw903-coder.github.io",
  "https://muse.ai",
];
const FALLBACK_ORIGIN = "https://fm-physio-dashboard-zol1.vercel.app";

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : FALLBACK_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), { status: 405, headers });
  }
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  if (body.action === "account_exists") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ ok: false, error: "valid email required" }), { status: 400, headers });
    }
    let exists = false;
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
      if (error) {
        return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers });
      }
      const users = data?.users ?? [];
      if (users.some((u: any) => String(u.email || "").toLowerCase() === email)) { exists = true; break; }
      if (users.length < 100) break;
      page++;
    }
    return new Response(JSON.stringify({ ok: true, exists }), { headers });
  }

  return new Response(JSON.stringify({ ok: false, error: "unknown action" }), { status: 400, headers });
});
