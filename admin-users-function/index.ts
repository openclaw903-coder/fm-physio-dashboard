// FM Physio — admin-users Edge Function
// Owner-only user management: invite by email, list users, per-page access,
// deactivate/reactivate, delete user. The invited user sets their own password
// from the Supabase invite email (link goes to the dashboard Site URL).
// JWT verification is ON: the dashboard must send the signed-in owner's
// access token in the Authorization header. The service-role key stays
// server-side here; the browser never sees it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://fm-physio-dashboard-zol1.vercel.app",
  "https://fm-physio-dashboard-iota.vercel.app",
  "https://openclaw903-coder.github.io",
  "https://muse.ai",
];
const FALLBACK_ORIGIN = "https://fm-physio-dashboard-zol1.vercel.app";
const SITE_URL = "https://fm-physio-dashboard-zol1.vercel.app";

// Must match the dashboard's data-page keys exactly.
const PAGES = ["overview","owner-overview","admin-today","appointments","patients","enquiries","cancellations","complaints","discharged","team","performance","progress","payments","ai","unprocessed","dnc"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : FALLBACK_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

function respond(headers: Record<string, string>, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

// Returns the owner user, or null when the caller is not an active owner.
async function requireOwner(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: row } = await sb
    .from("admin_users")
    .select("user_id, role, active")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!row || !row.active || row.role !== "owner") return null;
  return data.user;
}

async function listUsers() {
  const { data: admins, error: aErr } = await sb
    .from("admin_users")
    .select("user_id, display_name, role, active, created_at")
    .order("created_at");
  if (aErr) throw new Error(aErr.message);
  const { data: access } = await sb
    .from("user_page_access")
    .select("user_id, page_key, allowed");
  const { data: authList } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const emailById: Record<string, string> = {};
  (authList?.users || []).forEach((u: { id: string; email?: string }) => {
    if (u.email) emailById[u.id] = u.email;
  });
  return {
    ok: true,
    users: (admins || []).map((a: Record<string, unknown>) => ({
      user_id: a.user_id,
      display_name: a.display_name,
      role: a.role,
      active: a.active,
      created_at: a.created_at,
      email: emailById[String(a.user_id)] || null,
      pages: PAGES.filter((p) =>
        (access || []).some(
          (r: Record<string, unknown>) =>
            r.user_id === a.user_id && r.page_key === p && r.allowed === true,
        ),
      ),
    })),
  };
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return respond(headers, { ok: false, error: "POST only" }, 405);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const owner = await requireOwner(req);
    if (!owner) return respond(headers, { ok: false, error: "owner only" }, 403);

    const action = String(body.action || "");

    if (action === "list_users") {
      return respond(headers, await listUsers());
    }

    if (action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const displayName = String(body.display_name || "").trim() || email;
      const pages: string[] = Array.isArray(body.pages)
        ? body.pages.filter((p: unknown) => typeof p === "string" && PAGES.includes(p))
        : [];
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        return respond(headers, { ok: false, error: "valid email required" }, 400);
      }
      // Sends the Supabase invite email; the user sets their own password from it.
      // Needs the dashboard Site URL fixed to SITE_URL first, or the link breaks.
      const { data: inv, error: invErr } = await sb.auth.admin.inviteUserByEmail(email, {
        redirectTo: SITE_URL,
        data: { display_name: displayName },
      });
      if (invErr || !inv.user) {
        return respond(headers, { ok: false, error: invErr?.message || "invite failed" }, 400);
      }
      const uid = inv.user.id;
      const { error: insErr } = await sb.from("admin_users").insert({
        user_id: uid,
        display_name: displayName,
        role: "user",
        active: true,
      });
      if (insErr) {
        // Auth user exists but the admin row failed — report it, do not leave a half user.
        return respond(headers, { ok: false, error: "auth user created but admin row failed: " + insErr.message }, 500);
      }
      const { error: accErr } = await sb.from("user_page_access").insert(
        PAGES.map((p) => ({ user_id: uid, page_key: p, allowed: pages.includes(p) })),
      );
      if (accErr) {
        return respond(headers, { ok: false, error: "user created but page access failed: " + accErr.message }, 500);
      }
      return respond(headers, { ok: true, user_id: uid });
    }

    if (action === "set_pages") {
      const userId = String(body.user_id || "");
      const pages: string[] = Array.isArray(body.pages)
        ? body.pages.filter((p: unknown) => typeof p === "string" && PAGES.includes(p))
        : [];
      if (!userId) return respond(headers, { ok: false, error: "user_id required" }, 400);
      const { data: target } = await sb
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (!target) return respond(headers, { ok: false, error: "user not found" }, 404);
      if (target.role === "owner") {
        return respond(headers, { ok: false, error: "owner always has all pages" }, 400);
      }
      await sb.from("user_page_access").delete().eq("user_id", userId);
      const { error: insErr } = await sb.from("user_page_access").insert(
        PAGES.map((p) => ({ user_id: userId, page_key: p, allowed: pages.includes(p) })),
      );
      if (insErr) return respond(headers, { ok: false, error: insErr.message }, 500);
      return respond(headers, { ok: true });
    }

    if (action === "set_active") {
      const userId = String(body.user_id || "");
      const active = body.active === true;
      if (!userId) return respond(headers, { ok: false, error: "user_id required" }, 400);
      if (userId === owner.id) {
        return respond(headers, { ok: false, error: "cannot change your own access" }, 400);
      }
      const { data: target } = await sb
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (!target) return respond(headers, { ok: false, error: "user not found" }, 404);
      if (target.role === "owner") {
        return respond(headers, { ok: false, error: "cannot deactivate the owner" }, 400);
      }
      const { error: updErr } = await sb
        .from("admin_users")
        .update({ active })
        .eq("user_id", userId);
      if (updErr) return respond(headers, { ok: false, error: updErr.message }, 500);
      return respond(headers, { ok: true });
    }

    if (action === "delete_user") {
      const userId = String(body.user_id || "");
      if (!userId) return respond(headers, { ok: false, error: "user_id required" }, 400);
      if (userId === owner.id) {
        return respond(headers, { ok: false, error: "cannot delete yourself" }, 400);
      }
      const { data: target } = await sb
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (!target) return respond(headers, { ok: false, error: "user not found" }, 404);
      if (target.role === "owner") {
        return respond(headers, { ok: false, error: "cannot delete the owner" }, 400);
      }
      const { error: delErr } = await sb.auth.admin.deleteUser(userId);
      if (delErr) return respond(headers, { ok: false, error: delErr.message }, 500);
      await sb.from("admin_users").delete().eq("user_id", userId);
      return respond(headers, { ok: true });
    }

    return respond(headers, { ok: false, error: "unknown action: " + action }, 400);
  } catch (e) {
    return respond(headers, { ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
