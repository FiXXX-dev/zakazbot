// Вход клиентов по ACCESS_KEY (без регистрации).
//
// Подключается ПОСЛЕ js/supabase-client.js на страницах клиента
// (index/new-order/clients/admin/settings). Регистрации нет: ключи выдаёт
// владелец через admin-dashboard.html. Защищённые страницы вызывают
// Auth.guard() и запускают логику только при наличии сессии.
//
// Ключ проверяет Edge Function clientauth (service-role) и возвращает сессию
// Supabase; дальше доступ к данным ограничивают RLS (user_id = auth.uid()).

(function () {
  function sb() { return window.sb; }
  function cfg() { return window.CONFIG || {}; }

  function fnUrl() {
    return String(cfg().SUPABASE_URL || "").replace(/\/+$/, "") + "/functions/v1/clientauth";
  }

  async function currentUser() {
    if (!sb()) return null;
    try {
      const { data } = await sb().auth.getSession();
      return data && data.session ? data.session.user : null;
    } catch (e) { return null; }
  }

  // Меняет ACCESS_KEY на сессию Supabase через Edge Function и применяет её.
  async function keyLogin(accessKey) {
    const anon = cfg().SUPABASE_ANON_KEY;
    const resp = await fetch(fnUrl(), {
      method: "POST",
      headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", access_key: accessKey })
    });
    let data = null;
    try { data = await resp.json(); } catch (e) { /* не-JSON */ }
    if (!resp.ok) throw new Error((data && data.error) || ("HTTP " + resp.status));
    if (!data || !data.session) throw new Error("Сервер не вернул сессию.");
    await sb().auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token
    });
    return true;
  }

  // Гард: есть сессия → отдаём пользователя; нет → показываем форму входа по ключу.
  async function guard() {
    if (!sb()) return null; // конфиг не задан — страница покажет своё предупреждение
    const user = await currentUser();
    if (!user) { renderKeyLogin(); return null; }
    injectNav(user);
    if (window.Plan) { try { await window.Plan.load(user.id); window.Plan.renderBanners(); } catch (e) { /* best-effort */ } }
    return user;
  }

  function renderKeyLogin() {
    const main = document.querySelector("main.container");
    if (!main) return;
    main.innerHTML =
      "<h1>Вход в ZakazBot</h1>" +
      '<section class="card" style="max-width:460px">' +
        '<div class="field"><label for="ak-input">Ваш ключ доступа</label>' +
        '<input type="text" id="ak-input" placeholder="например, K7M2X9P4Q8R3T6V1" autocomplete="off" spellcheck="false"></div>' +
        '<div style="margin-top:12px"><button type="button" id="ak-btn" class="btn">Войти</button></div>' +
        '<div id="ak-msg"></div>' +
        '<p class="client-sub" style="margin-top:12px">Ключ доступа выдаёт поставщик. Регистрация не требуется.</p>' +
      "</section>";

    const inp = main.querySelector("#ak-input");
    const btn = main.querySelector("#ak-btn");
    const msg = main.querySelector("#ak-msg");

    function submit() {
      const key = inp.value.trim();
      if (!key) { msg.innerHTML = '<div class="msg msg-warn">Введите ключ доступа.</div>'; return; }
      btn.disabled = true;
      msg.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Проверяю ключ…</div>';
      keyLogin(key)
        .then(function () { location.reload(); })
        .catch(function (e) {
          btn.disabled = false;
          msg.innerHTML = '<div class="msg msg-error">' + esc(e && e.message ? e.message : String(e)) + "</div>";
        });
    }
    btn.addEventListener("click", submit);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    inp.focus();
  }

  // В шапке: название компании + «Тариф» + «Выйти».
  function injectNav(user) {
    const company = (user.user_metadata && user.user_metadata.company) || "";
    document.querySelectorAll(".topbar nav").forEach(function (nav) {
      if (nav.querySelector(".auth-area")) return;

      if (!nav.querySelector('a[href="settings.html"]')) {
        const s = document.createElement("a");
        s.href = "settings.html";
        s.textContent = "Тариф";
        nav.appendChild(s);
      }

      const area = document.createElement("span");
      area.className = "auth-area";
      const who = document.createElement("span");
      who.className = "auth-email";
      who.title = company;
      who.textContent = company;
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
    location.reload();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.Auth = {
    currentUser: currentUser,
    guard: guard,
    keyLogin: keyLogin,
    signOut: signOut
  };
})();
