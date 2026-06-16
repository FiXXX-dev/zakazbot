// Тарифы и лимиты: загрузка подписки + plan_limits, баннеры лимитов, фичефлаги.
//
// Подключается ПОСЛЕ js/auth.js. Auth.guard() сам вызывает Plan.load() и
// Plan.renderBanners(), поэтому на защищённых страницах с этим скриптом баннеры
// лимитов и Plan.data() доступны автоматически.

(function () {
  let cache = null; // { plan, status, expires_at, limits, productCount, clientCount }

  function defaultLimits(plan) {
    return plan === "pro"
      ? { max_products: null, max_clients: null, has_analytics: true,
          has_1c_integration: true, has_priority_support: true, has_custom_branding: true }
      : { max_products: 500, max_clients: 50, has_analytics: false,
          has_1c_integration: false, has_priority_support: false, has_custom_branding: false };
  }

  async function load(userId) {
    cache = { plan: "basic", status: "active", expires_at: null, limits: defaultLimits("basic"), productCount: 0, clientCount: 0 };
    if (!window.sb || !userId) return cache;
    try {
      // Параллельно и устойчиво: сбой одного запроса не роняет остальные.
      const r = await Promise.allSettled([
        window.sb.from("subscriptions").select("plan,status,expires_at").eq("user_id", userId).maybeSingle(),
        window.sb.from("plan_limits").select("*"),
        window.sb.from("products").select("id", { count: "exact", head: true }).eq("user_id", userId),
        window.sb.from("clients").select("id", { count: "exact", head: true }).eq("user_id", userId)
      ]);
      const val = function (i) { return r[i].status === "fulfilled" ? r[i].value : null; };

      const sub = val(0);
      if (sub && sub.data) {
        cache.plan = sub.data.plan || "basic";
        cache.status = sub.data.status || "active";
        cache.expires_at = sub.data.expires_at || null;
      }
      const lim = val(1);
      const rows = (lim && lim.data) || [];
      const row = rows.filter(function (x) { return x.plan === cache.plan; })[0];
      cache.limits = row || defaultLimits(cache.plan);

      const pc = val(2);
      const cc = val(3);
      cache.productCount = (pc && pc.count) || 0;
      cache.clientCount = (cc && cc.count) || 0;
    } catch (e) { /* best-effort: остаются дефолты basic */ }
    return cache;
  }

  function data() { return cache; }
  function isPro() { return !!(cache && cache.plan === "pro"); }
  function has(feature) { return !!(cache && cache.limits && cache.limits[feature]); }

  // Баннеры лимитов (только для basic, когда достигнут потолок товаров/клиентов).
  function renderBanners() {
    if (!cache) return;
    const main = document.querySelector("main.container");
    if (!main) return;
    let box = document.getElementById("plan-banner");
    if (!box) {
      box = document.createElement("div");
      box.id = "plan-banner";
      main.insertBefore(box, main.firstChild);
    }
    const msgs = [];
    if (cache.plan === "basic" && cache.limits) {
      const mp = cache.limits.max_products;
      const mc = cache.limits.max_clients;
      if (mp != null && cache.productCount >= mp) {
        msgs.push("Достигнут лимит товаров (" + cache.productCount + " / " + mp +
          ") на тарифе Basic. <a href=\"settings.html\">Перейти на Pro</a>");
      }
      if (mc != null && cache.clientCount >= mc) {
        msgs.push("Достигнут лимит клиентов (" + cache.clientCount + " / " + mc +
          ") на тарифе Basic. <a href=\"settings.html\">Перейти на Pro</a>");
      }
    }
    box.innerHTML = msgs.map(function (m) {
      return '<div class="msg msg-warn">⚠ ' + m + "</div>";
    }).join("");
  }

  window.Plan = {
    load: load,
    data: data,
    isPro: isPro,
    has: has,
    renderBanners: renderBanners,
    defaultLimits: defaultLimits
  };
})();
