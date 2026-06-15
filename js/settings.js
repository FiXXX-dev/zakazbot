// Страница «Тариф» (settings.html): текущий план, даты, сравнение Basic/Pro,
// кнопка перехода на Pro. План меняет администратор (RLS), поэтому «Upgrade» —
// это заявка на почту администратора, а не самостоятельная смена тарифа.

(function () {
  const PLAN_LABELS = { basic: "Basic", pro: "Pro" };
  const FEATURES = [
    { key: "max_products", label: "Товаров", fmt: limitFmt },
    { key: "max_clients", label: "Клиентов", fmt: limitFmt },
    { key: "has_analytics", label: "Аналитика", fmt: boolFmt },
    { key: "has_1c_integration", label: "Интеграция с 1С", fmt: boolFmt },
    { key: "has_priority_support", label: "Приоритетная поддержка", fmt: boolFmt },
    { key: "has_custom_branding", label: "Свой брендинг", fmt: boolFmt }
  ];

  const els = {
    setup: document.getElementById("setup-warning"),
    body: document.getElementById("settings-body")
  };

  let user = null;

  boot();

  function boot() {
    if (!window.sb) {
      els.setup.innerHTML = '<div class="msg msg-warn">Supabase не настроен: заполните <code>config.js</code>.</div>';
      return;
    }
    window.Auth.guard().then(function (u) {
      if (!u) return;
      user = u;
      render();
    });
  }

  async function render() {
    els.body.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка…</div>';

    const subRes = await window.sb.from("subscriptions")
      .select("plan,status,created_at,expires_at").eq("user_id", user.id).maybeSingle();
    const sub = subRes.data || { plan: "basic", status: "active", created_at: null, expires_at: null };

    const limRes = await window.sb.from("plan_limits").select("*");
    const limits = {};
    (limRes.data || []).forEach(function (r) { limits[r.plan] = r; });
    if (!limits.basic) limits.basic = window.Plan.defaultLimits("basic");
    if (!limits.pro) limits.pro = window.Plan.defaultLimits("pro");

    const isPro = sub.plan === "pro";
    const statusBadge = sub.status === "active"
      ? '<span class="badge badge-ready">Активна</span>'
      : '<span class="badge badge-urgent">Истекла</span>';

    let html = "";

    // Текущий тариф
    html +=
      '<section class="card">' +
        '<div class="order-head">' +
          "<div>" +
            '<div class="order-client">Текущий тариф: ' + esc(PLAN_LABELS[sub.plan] || sub.plan) + "</div>" +
            '<div class="order-meta">Регистрация: ' + esc(fmtDate(sub.created_at)) +
              (sub.expires_at ? " · действует до: " + esc(fmtDate(sub.expires_at)) : " · бессрочно") + "</div>" +
          "</div>" +
          statusBadge +
        "</div>" +
        (isPro
          ? '<div class="msg msg-success" style="margin-bottom:0">У вас тариф Pro — все функции доступны.</div>'
          : '<div class="order-actions"><button type="button" id="upgrade-btn" class="btn">Upgrade на Pro</button></div>') +
        '<div id="upgrade-msg"></div>' +
      "</section>";

    // Сравнение тарифов
    html +=
      '<section class="card"><h2 style="margin-top:0">Что входит в тарифы</h2>' +
      '<div class="table-wrap"><table class="items-table"><thead><tr>' +
        "<th>Возможность</th><th>Basic</th><th>Pro</th>" +
      "</tr></thead><tbody>" +
      FEATURES.map(function (f) {
        return "<tr>" +
          "<td>" + esc(f.label) + "</td>" +
          "<td>" + f.fmt(limits.basic ? limits.basic[f.key] : null) + "</td>" +
          "<td>" + f.fmt(limits.pro ? limits.pro[f.key] : null) + "</td>" +
        "</tr>";
      }).join("") +
      "</tbody></table></div></section>";

    els.body.innerHTML = html;

    const upBtn = document.getElementById("upgrade-btn");
    if (upBtn) upBtn.addEventListener("click", onUpgrade);
  }

  function onUpgrade() {
    const admin = String((window.CONFIG && window.CONFIG.ADMIN_EMAIL) || "").trim();
    const msg = document.getElementById("upgrade-msg");
    if (admin) {
      const subject = encodeURIComponent("ZakazBot: переход на Pro");
      const bodyText = encodeURIComponent("Здравствуйте! Прошу подключить тариф Pro для аккаунта: " + (user.email || ""));
      window.location.href = "mailto:" + admin + "?subject=" + subject + "&body=" + bodyText;
    }
    msg.innerHTML = '<div class="msg msg-info">Заявка формируется письмом администратору (' +
      esc(admin || "—") + "). Тариф активирует администратор после оплаты.</div>";
  }

  function limitFmt(v) { return v == null ? "Безлимит" : String(v); }
  function boolFmt(v) { return v ? "✓" : "—"; }

  function fmtDate(iso) {
    if (!iso) return "—";
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
