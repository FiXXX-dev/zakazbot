// Панель администратора (dashboard.html): список всех подписок, статистика
// использования и управление подпиской клиента (план/статус).
//
// Доступ только администратору (Auth.guard({ admin: true }) + RLS is_admin()).

(function () {
  const PLANS = { basic: "Basic", standard: "Standard", business: "Business" };
  const STATUS = { active: "Активна", expired: "Истекла" };

  const els = {
    setup: document.getElementById("setup-warning"),
    stats: document.getElementById("stats"),
    list: document.getElementById("subs-list"),
    search: document.getElementById("search-input"),
    status: document.getElementById("status-filter"),
    refresh: document.getElementById("refresh-btn")
  };

  let subs = [];
  let orderCounts = {}; // user_id → число заказов

  boot();

  function boot() {
    if (!window.sb) {
      els.setup.innerHTML =
        '<div class="msg msg-warn">Supabase не настроен: заполните <code>config.js</code>.</div>';
      return;
    }
    window.Auth.guard({ admin: true }).then(function (user) {
      if (!user) return; // не админ/не залогинен — guard уже сделал редирект
      els.search.addEventListener("input", render);
      els.status.addEventListener("change", render);
      els.refresh.addEventListener("click", loadData);
      loadData();
    });
  }

  async function loadData() {
    els.list.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка подписок…</div>';

    const subsRes = await window.sb
      .from("subscriptions")
      .select("*")
      .order("created_at", { ascending: false });
    if (subsRes.error) {
      els.list.innerHTML = '<div class="msg msg-error">Не удалось загрузить подписки: ' +
        esc(subsRes.error.message) + "</div>";
      return;
    }
    subs = subsRes.data || [];

    // Статистика использования: число заказов на пользователя (админ видит все).
    orderCounts = {};
    const ordRes = await window.sb.from("orders").select("user_id");
    if (!ordRes.error && ordRes.data) {
      ordRes.data.forEach(function (o) {
        if (!o.user_id) return;
        orderCounts[o.user_id] = (orderCounts[o.user_id] || 0) + 1;
      });
    }

    renderStats(ordRes.data ? ordRes.data.length : 0);
    render();
  }

  function renderStats(totalOrders) {
    const total = subs.length;
    const active = subs.filter(function (s) { return s.status === "active"; }).length;
    const expired = total - active;
    els.stats.innerHTML =
      statBadge("Подписок", total) +
      statBadge("Активных", active) +
      statBadge("Истёкших", expired) +
      statBadge("Заказов всего", totalOrders);
  }

  function statBadge(label, value) {
    return '<span class="badge badge-new" style="font-size:13px">' +
      esc(label) + ": <b>" + esc(String(value)) + "</b></span>";
  }

  function render() {
    const q = els.search.value.trim().toLowerCase();
    const st = els.status.value;
    const list = subs.filter(function (s) {
      if (st !== "all" && s.status !== st) return false;
      if (q && String(s.client_name || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    if (!list.length) {
      els.list.innerHTML = '<div class="msg msg-info">Подписок не найдено.</div>';
      return;
    }
    els.list.innerHTML = "";
    list.forEach(function (s) { els.list.appendChild(subCard(s)); });
  }

  function subCard(s) {
    const card = document.createElement("div");
    card.className = "card";
    const orders = orderCounts[s.user_id] || 0;

    card.innerHTML =
      '<div class="order-head">' +
        "<div>" +
          '<div class="order-client">' + esc(s.client_name || "Без названия") + "</div>" +
          '<div class="order-meta">Регистрация: ' + esc(fmtDate(s.created_at)) +
            " · план: " + esc(PLANS[s.plan] || s.plan) +
            " · заказов: " + orders + "</div>" +
        "</div>" +
        '<span class="badge badge-' + (s.status === "active" ? "ready" : "urgent") + '">' +
          esc(STATUS[s.status] || s.status) + "</span>" +
      "</div>" +
      '<div class="order-actions">' +
        '<button type="button" class="btn btn-outline btn-sm manage-btn">Управлять клиентом</button>' +
      "</div>" +
      '<div class="client-details hidden manage-box"></div>';

    const box = card.querySelector(".manage-box");
    card.querySelector(".manage-btn").addEventListener("click", function () {
      if (!box.classList.contains("hidden")) { box.classList.add("hidden"); box.innerHTML = ""; return; }
      box.classList.remove("hidden");
      renderManage(s, box, card);
    });

    return card;
  }

  function renderManage(s, box, card) {
    box.innerHTML =
      '<div class="form-row">' +
        '<div class="field"><label>План</label>' + planSelect(s.plan) + "</div>" +
        '<div class="field"><label>Статус</label>' + statusSelect(s.status) + "</div>" +
      "</div>" +
      '<div class="order-actions">' +
        '<button type="button" class="btn btn-sm save-btn">Сохранить</button>' +
      "</div>" +
      '<div class="manage-msg"></div>';

    const planSel = box.querySelector(".plan-sel");
    const statusSel = box.querySelector(".status-sel");
    const msg = box.querySelector(".manage-msg");

    box.querySelector(".save-btn").addEventListener("click", async function (e) {
      const btn = e.target;
      btn.disabled = true;
      const update = { plan: planSel.value, status: statusSel.value };
      const { error } = await window.sb.from("subscriptions").update(update).eq("id", s.id);
      btn.disabled = false;
      if (error) {
        msg.innerHTML = '<div class="msg msg-error">Не удалось сохранить: ' + esc(error.message) + "</div>";
        return;
      }
      Object.assign(s, update);
      msg.innerHTML = '<div class="msg msg-success">Сохранено.</div>';
      // Обновляем шапку карточки (бейдж/план).
      const head = card.querySelector(".order-head");
      const badge = head.querySelector(".badge");
      badge.className = "badge badge-" + (s.status === "active" ? "ready" : "urgent");
      badge.textContent = STATUS[s.status] || s.status;
    });
  }

  function planSelect(cur) {
    return '<select class="plan-sel">' + Object.keys(PLANS).map(function (p) {
      return '<option value="' + p + '"' + (p === cur ? " selected" : "") + ">" + PLANS[p] + "</option>";
    }).join("") + "</select>";
  }

  function statusSelect(cur) {
    return '<select class="status-sel">' + Object.keys(STATUS).map(function (s) {
      return '<option value="' + s + '"' + (s === cur ? " selected" : "") + ">" + STATUS[s] + "</option>";
    }).join("") + "</select>";
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
