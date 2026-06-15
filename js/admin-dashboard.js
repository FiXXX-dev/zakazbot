// Админка владельца (admin-dashboard.html): создание клиентов и выдача
// ACCESS_KEY. Пароль администратора проверяется НА СЕРВЕРЕ (Edge Function
// clientauth, секрет ADMIN_PANEL_SECRET) — в браузере/репозитории его нет.
// Пароль хранится в sessionStorage на время вкладки и шлётся с каждым запросом.

(function () {
  const PLANS = { basic: "Basic", pro: "Pro" };
  const STORE_KEY = "zb_admin_secret";

  const els = {
    setup: document.getElementById("setup-warning"),
    gate: document.getElementById("admin-gate"),
    pass: document.getElementById("admin-pass"),
    enter: document.getElementById("admin-enter"),
    gateMsg: document.getElementById("gate-msg"),
    panel: document.getElementById("admin-panel"),
    logout: document.getElementById("admin-logout"),
    company: document.getElementById("nc-company"),
    email: document.getElementById("nc-email"),
    plan: document.getElementById("nc-plan"),
    create: document.getElementById("nc-create"),
    result: document.getElementById("nc-result"),
    table: document.getElementById("clients-table")
  };

  let secret = "";

  init();

  function init() {
    if (!window.CONFIG || !window.CONFIG.SUPABASE_URL || !window.CONFIG.SUPABASE_ANON_KEY ||
        String(window.CONFIG.SUPABASE_URL).indexOf("YOUR-PROJECT") !== -1) {
      els.setup.innerHTML = '<div class="msg msg-warn">Supabase не настроен в <code>config.js</code>.</div>';
      els.gate.classList.add("hidden");
      return;
    }
    els.enter.addEventListener("click", onEnter);
    els.pass.addEventListener("keydown", function (e) { if (e.key === "Enter") onEnter(); });
    els.create.addEventListener("click", onCreate);
    els.logout.addEventListener("click", function (e) { e.preventDefault(); lock(); });

    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) { secret = saved; unlock(); }
  }

  function fnUrl() {
    return String(window.CONFIG.SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/clientauth";
  }

  async function callFn(payload) {
    const anon = window.CONFIG.SUPABASE_ANON_KEY;
    const resp = await fetch(fnUrl(), {
      method: "POST",
      headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ admin_secret: secret }, payload))
    });
    let data = null;
    try { data = await resp.json(); } catch (e) { /* не-JSON */ }
    if (!resp.ok) {
      const err = new Error((data && data.error) || ("HTTP " + resp.status));
      err.status = resp.status;
      throw err;
    }
    return data || {};
  }

  function onEnter() {
    secret = els.pass.value;
    if (!secret) { els.gateMsg.innerHTML = '<div class="msg msg-warn">Введите пароль.</div>'; return; }
    els.enter.disabled = true;
    els.gateMsg.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Проверяю…</div>';
    loadClients()
      .then(function () {
        sessionStorage.setItem(STORE_KEY, secret);
        els.gateMsg.innerHTML = "";
        unlock();
      })
      .catch(function (e) {
        secret = "";
        els.gateMsg.innerHTML = '<div class="msg msg-error">' + esc(e.message) + "</div>";
      })
      .finally(function () { els.enter.disabled = false; });
  }

  function unlock() {
    els.gate.classList.add("hidden");
    els.panel.classList.remove("hidden");
    els.logout.style.display = "";
    loadClients().catch(function (e) {
      if (e.status === 401) { lock(); return; }
      els.table.innerHTML = '<div class="msg msg-error">' + esc(e.message) + "</div>";
    });
  }

  function lock() {
    sessionStorage.removeItem(STORE_KEY);
    secret = "";
    els.panel.classList.add("hidden");
    els.gate.classList.remove("hidden");
    els.logout.style.display = "none";
    els.pass.value = "";
    els.pass.focus();
  }

  async function onCreate() {
    const company = els.company.value.trim();
    if (!company) { showResult("warn", "Укажите название компании."); return; }
    els.create.disabled = true;
    showResult("info", '<span class="spinner"></span> Создаю клиента…');
    try {
      const data = await callFn({
        action: "admin_create",
        company_name: company,
        email: els.email.value.trim(),
        plan: els.plan.value
      });
      els.company.value = "";
      els.email.value = "";
      els.result.innerHTML =
        '<div class="msg msg-success"><b>Клиент создан.</b> Передайте клиенту ключ доступа:</div>' +
        '<div class="key-row"><code class="key-code">' + esc(data.access_key) + "</code>" +
        '<button type="button" class="btn btn-outline btn-sm key-copy">Скопировать ключ</button></div>';
      const btn = els.result.querySelector(".key-copy");
      btn.addEventListener("click", function () { copyKey(data.access_key, btn); });
      loadClients().catch(function () {});
    } catch (e) {
      if (e.status === 401) { lock(); return; }
      showResult("error", esc(e.message));
    } finally {
      els.create.disabled = false;
    }
  }

  async function loadClients() {
    const data = await callFn({ action: "admin_list" });
    renderClients(data.clients || []);
    return data;
  }

  function renderClients(list) {
    if (!list.length) {
      els.table.innerHTML = '<div class="msg msg-info">Клиентов пока нет.</div>';
      return;
    }
    const rows = list.map(function (c) {
      return "<tr>" +
        "<td>" + esc(c.company_name) + (c.email ? '<div class="item-note" style="color:var(--muted)">' + esc(c.email) + "</div>" : "") + "</td>" +
        "<td>" + planSelect(c) + "</td>" +
        "<td>" + statusSelect(c) + "</td>" +
        "<td>" + esc(fmtDate(c.created_at)) + "</td>" +
        '<td class="key-cell"><code class="key-code">' + esc(c.access_key) + "</code>" +
          '<button type="button" class="btn btn-outline btn-sm key-copy" data-key="' + esc(c.access_key) + '">Скопировать</button></td>' +
        "</tr>";
    }).join("");
    els.table.innerHTML =
      '<div class="table-wrap"><table class="items-table"><thead><tr>' +
        "<th>Компания</th><th>План</th><th>Статус</th><th>Создан</th><th>Ключ доступа</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";

    els.table.querySelectorAll(".key-copy").forEach(function (btn) {
      btn.addEventListener("click", function () { copyKey(btn.dataset.key, btn); });
    });
    els.table.querySelectorAll(".plan-sel").forEach(function (sel) {
      sel.addEventListener("change", function () { update(sel.dataset.id, { plan: sel.value }); });
    });
    els.table.querySelectorAll(".status-sel").forEach(function (sel) {
      sel.addEventListener("change", function () { update(sel.dataset.id, { status: sel.value }); });
    });
  }

  async function update(id, patch) {
    try {
      await callFn(Object.assign({ action: "admin_update", id: id }, patch));
    } catch (e) {
      if (e.status === 401) { lock(); return; }
      alert("Не удалось обновить: " + e.message);
      loadClients().catch(function () {});
    }
  }

  function planSelect(c) {
    return '<select class="plan-sel" data-id="' + esc(c.id) + '">' +
      Object.keys(PLANS).map(function (p) {
        return '<option value="' + p + '"' + (p === c.plan ? " selected" : "") + ">" + PLANS[p] + "</option>";
      }).join("") + "</select>";
  }

  function statusSelect(c) {
    const opts = { active: "Активен", inactive: "Отключён" };
    return '<select class="status-sel" data-id="' + esc(c.id) + '">' +
      Object.keys(opts).map(function (s) {
        return '<option value="' + s + '"' + (s === c.status ? " selected" : "") + ">" + opts[s] + "</option>";
      }).join("") + "</select>";
  }

  function copyKey(key, btn) {
    const done = function () {
      const t = btn.textContent;
      btn.textContent = "Скопировано ✓";
      setTimeout(function () { btn.textContent = t; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(key).then(done, function () { fallbackCopy(key, done); });
    } else {
      fallbackCopy(key, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function showResult(type, html) {
    els.result.innerHTML = '<div class="msg msg-' + type + '">' + html + "</div>";
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
