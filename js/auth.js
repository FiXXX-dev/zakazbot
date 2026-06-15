// Аутентификация и разделение доступа (Supabase Auth).
//
// Подключается на каждой странице ПОСЛЕ js/supabase-client.js.
// Защищённые страницы вызывают Auth.guard() (или Auth.guard({ admin: true }))
// и запускают свою логику только если вернулся пользователь.
//
// Реальное разделение данных обеспечивают RLS-политики в sql/schema.sql
// (user_id = auth.uid()); фронтенд дополнительно фильтрует по user_id.

(function () {
  function sb() { return window.sb; }

  async function currentUser() {
    if (!sb()) return null;
    try {
      const { data } = await sb().auth.getSession();
      return data && data.session ? data.session.user : null;
    } catch (e) {
      return null;
    }
  }

  function isAdmin(user) {
    const admin = String((window.CONFIG && window.CONFIG.ADMIN_EMAIL) || "").trim().toLowerCase();
    return !!(admin && user && user.email && user.email.toLowerCase() === admin);
  }

  // Гард защищённой страницы. Возвращает user (или null + редирект).
  //   opts.admin === true → пускает только администратора.
  async function guard(opts) {
    opts = opts || {};
    if (!sb()) return null; // конфиг не задан — страница покажет своё предупреждение
    const user = await currentUser();
    if (!user) { location.replace("login.html"); return null; }
    if (opts.admin && !isAdmin(user)) { location.replace("index.html"); return null; }
    await ensureSubscription(user);
    injectNav(user);
    return user;
  }

  // Создаёт подписку (active/basic) при первом входе. Best-effort, без обновления
  // существующей (менять статус/план может только админ — см. RLS).
  async function ensureSubscription(user) {
    try {
      await sb().from("subscriptions").upsert(
        { user_id: user.id, client_name: companyNameFor(user) },
        { onConflict: "user_id", ignoreDuplicates: true }
      );
    } catch (e) { /* не критично */ }
  }

  function companyNameFor(user) {
    const meta = user.user_metadata || {};
    return String(meta.company || meta.client_name || user.email || "");
  }

  // Добавляет в шапку email + «Выйти», а для админа — ссылку на «Подписки».
  function injectNav(user) {
    const navs = document.querySelectorAll(".topbar nav");
    navs.forEach(function (nav) {
      if (nav.querySelector(".auth-area")) return;

      if (isAdmin(user) && !nav.querySelector('a[href="dashboard.html"]')) {
        const d = document.createElement("a");
        d.href = "dashboard.html";
        d.textContent = "Подписки";
        nav.appendChild(d);
      }

      const area = document.createElement("span");
      area.className = "auth-area";

      const who = document.createElement("span");
      who.className = "auth-email";
      who.title = user.email || "";
      who.textContent = user.email || "";

      const out = document.createElement("a");
      out.href = "#";
      out.className = "auth-logout";
      out.textContent = "Выйти";
      out.addEventListener("click", function (e) { e.preventDefault(); signOut(); });

      area.appendChild(who);
      area.appendChild(out);
      nav.appendChild(area);
    });
  }

  async function signOut() {
    if (sb()) { try { await sb().auth.signOut(); } catch (e) { /* ignore */ } }
    location.replace("login.html");
  }

  window.Auth = {
    currentUser: currentUser,
    isAdmin: isAdmin,
    guard: guard,
    signOut: signOut
  };
})();
