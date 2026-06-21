// Supabase Edge Function: clientauth
//
// Вход клиентов по ACCESS_KEY и админ-операции (создание/список/обновление/
// удаление клиентов). Все привилегированные действия выполняются на service-role и
// защищены секретом ADMIN_PANEL_SECRET. Таблица clients_accounts закрыта RLS,
// поэтому ключи доступа НЕ читаются публичным anon-ключом.
//
// Деплой: автоматически через .github/workflows/deploy-functions.yml
//   (supabase functions deploy --no-verify-jwt).
// Секрет админки: supabase secrets set ADMIN_PANEL_SECRET=<пароль>
//   (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY Supabase
//    подставляет в функции автоматически).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ADMIN_SECRET = Deno.env.get("ADMIN_PANEL_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// 16 символов без неоднозначных 0/O/1/I.
function genKey(n = 16): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[bytes[i] % alpha.length];
  return s;
}

function service() {
  return createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Используйте POST" }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Некорректный JSON" }, 400); }
  const action = body?.action;

  try {
    // ── Публичное действие: вход клиента по ключу ──
    if (action === "login") {
      const key = String(body.access_key ?? "").trim();
      if (!key) return json({ error: "Введите ключ доступа" }, 400);
      const svc = service();
      const { data: acct } = await svc
        .from("clients_accounts")
        .select("auth_email, status")
        .eq("access_key", key)
        .maybeSingle();
      if (!acct) return json({ error: "Неверный ключ доступа" }, 401);
      if (acct.status !== "active") return json({ error: "Доступ отключён. Обратитесь к поставщику." }, 403);

      const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
      const { data: si, error } = await anon.auth.signInWithPassword({ email: acct.auth_email, password: key });
      if (error || !si.session) return json({ error: "Не удалось войти по ключу" }, 401);
      return json({
        session: { access_token: si.session.access_token, refresh_token: si.session.refresh_token },
      });
    }

    // ── Админ-операции: требуют корректный ADMIN_PANEL_SECRET ──
    const secret = String(body.admin_secret ?? "");
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return json({ error: "Неверный пароль администратора" }, 401);
    }
    const svc = service();

    if (action === "admin_list") {
      const { data, error } = await svc
        .from("clients_accounts")
        .select("id, company_name, email, access_key, plan, status, created_at, customer_code")
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      // Бэкфилл кода приглашения для старых аккаунтов.
      for (const row of data ?? []) {
        if (!row.customer_code) {
          const code = genKey(10);
          await svc.from("clients_accounts").update({ customer_code: code }).eq("id", row.id);
          row.customer_code = code;
        }
      }
      return json({ clients: data ?? [] });
    }

    if (action === "admin_create") {
      const company = String(body.company_name ?? "").trim();
      const email = String(body.email ?? "").trim() || null;
      const plan = body.plan === "pro" ? "pro" : "basic";
      if (!company) return json({ error: "Укажите название компании" }, 400);

      const access_key = genKey(16);
      const auth_email = access_key.toLowerCase() + "@clients.zakazbot.app";

      const { data: created, error: cErr } = await svc.auth.admin.createUser({
        email: auth_email,
        password: access_key,
        email_confirm: true,
        user_metadata: { company },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message ?? "Не удалось создать пользователя" }, 500);
      const user_id = created.user.id;

      const { error: iErr } = await svc.from("clients_accounts").insert({
        company_name: company, email, access_key, plan, status: "active", user_id, auth_email,
        customer_code: genKey(10),
      });
      if (iErr) return json({ error: iErr.message }, 500);

      await svc.from("subscriptions").upsert(
        { user_id, client_name: company, plan, status: "active" },
        { onConflict: "user_id" },
      );

      return json({ access_key, company_name: company, plan });
    }

    if (action === "admin_update") {
      const id = String(body.id ?? "");
      if (!id) return json({ error: "Не указан id" }, 400);
      const patch: Record<string, string> = {};
      if (body.plan === "basic" || body.plan === "pro") patch.plan = body.plan;
      if (body.status === "active" || body.status === "inactive") patch.status = body.status;
      if (!Object.keys(patch).length) return json({ error: "Нечего обновлять" }, 400);

      const { data: row, error } = await svc
        .from("clients_accounts").update(patch).eq("id", id)
        .select("user_id, plan, status").maybeSingle();
      if (error) return json({ error: error.message }, 500);

      if (row?.user_id) {
        const subPatch: Record<string, string> = {};
        if (patch.plan) subPatch.plan = patch.plan;
        if (patch.status) subPatch.status = patch.status === "active" ? "active" : "expired";
        if (Object.keys(subPatch).length) await svc.from("subscriptions").update(subPatch).eq("user_id", row.user_id);
      }
      return json({ ok: true });
    }

    if (action === "admin_delete") {
      const id = String(body.id ?? "");
      if (!id) return json({ error: "Не указан id" }, 400);
      const { data: acct, error: aErr } = await svc
        .from("clients_accounts").select("user_id").eq("id", id).maybeSingle();
      if (aErr) return json({ error: aErr.message }, 500);
      if (!acct) return json({ error: "Аккаунт не найден" }, 404);
      // Удаляем auth-пользователя — каскад (on delete cascade по user_id) снесёт
      // его данные: orders / clients / products / order_logs / subscriptions /
      // telegram_links и саму строку clients_accounts.
      if (acct.user_id) {
        const { error: dErr } = await svc.auth.admin.deleteUser(acct.user_id);
        if (dErr) return json({ error: dErr.message }, 500);
      }
      // На случай user_id = null (каскад не сработает) — удаляем строку явно.
      await svc.from("clients_accounts").delete().eq("id", id);
      return json({ ok: true });
    }

    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
