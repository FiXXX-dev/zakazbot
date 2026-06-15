// Аналитика для тарифа Pro (вкладка на clients.html). Chart.js с CDN.
//
// window.Analytics.render(container, userId):
//   • заказы по дням (последние 30),
//   • топ-5 клиентов по сумме,
//   • топ-10 товаров по популярности (по суммарному количеству).

(function () {
  let charts = [];

  function destroy() {
    charts.forEach(function (c) { try { c.destroy(); } catch (e) {} });
    charts = [];
  }

  function orderSum(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce(function (acc, it) {
      const q = Number(it && it.qty);
      const p = Number(it && it.price);
      return acc + (isFinite(q) && isFinite(p) ? q * p : 0);
    }, 0);
  }

  function dayKey(iso) {
    const d = new Date(iso);
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  async function render(container, userId) {
    if (typeof Chart === "undefined") {
      container.innerHTML = '<div class="msg msg-error">Chart.js не загрузился (проверьте доступ к CDN).</div>';
      return;
    }
    destroy();
    container.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка аналитики…</div>';

    const { data, error } = await window.sb
      .from("orders")
      .select("created_at, client_name, items")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      container.innerHTML = '<div class="msg msg-error">Не удалось загрузить аналитику: ' + esc(error.message) + "</div>";
      return;
    }
    const orders = data || [];
    if (!orders.length) {
      container.innerHTML = '<div class="msg msg-info">Пока нет заказов для аналитики.</div>';
      return;
    }

    // ── Агрегации ──
    const byDay = {};
    const byClient = {};
    const byProduct = {};
    orders.forEach(function (o) {
      byDay[dayKey(o.created_at)] = (byDay[dayKey(o.created_at)] || 0) + 1;
      const name = String(o.client_name || "Без имени").trim();
      byClient[name] = (byClient[name] || 0) + orderSum(o.items);
      (Array.isArray(o.items) ? o.items : []).forEach(function (it) {
        const key = String((it && it.name) || "").trim().toLowerCase();
        if (!key) return;
        const q = Number(it.qty);
        byProduct[key] = (byProduct[key] || 0) + (isFinite(q) ? q : 0);
      });
    });

    const days = Object.keys(byDay).sort().slice(-30);
    const topClients = topN(byClient, 5);
    const topProducts = topN(byProduct, 10);

    // ── Разметка ──
    container.innerHTML =
      '<div class="card"><h3 style="margin-top:0">Заказы по дням</h3><canvas id="ch-days" height="110"></canvas></div>' +
      '<div class="card"><h3 style="margin-top:0">Топ-5 клиентов по сумме</h3><canvas id="ch-clients" height="160"></canvas></div>' +
      '<div class="card"><h3 style="margin-top:0">Топ-10 товаров по популярности</h3><canvas id="ch-products" height="220"></canvas></div>';

    const accent = "#0d7d6f";
    charts.push(new Chart(container.querySelector("#ch-days"), barCfg(
      days, days.map(function (d) { return byDay[d]; }), "Заказов", accent, false
    )));
    charts.push(new Chart(container.querySelector("#ch-clients"), barCfg(
      topClients.map(kv), topClients.map(kvv), "Сумма", accent, true
    )));
    charts.push(new Chart(container.querySelector("#ch-products"), barCfg(
      topProducts.map(kv), topProducts.map(kvv), "Количество", "#b26a00", true
    )));
  }

  function topN(obj, n) {
    return Object.keys(obj)
      .map(function (k) { return [k, obj[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, n);
  }
  function kv(pair) { return pair[0]; }
  function kvv(pair) { return Math.round(pair[1] * 100) / 100; }

  function barCfg(labels, values, label, color, horizontal) {
    return {
      type: "bar",
      data: { labels: labels, datasets: [{ label: label, data: values, backgroundColor: color }] },
      options: {
        indexAxis: horizontal ? "y" : "x",
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true }, y: { beginAtZero: true } }
      }
    };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.Analytics = { render: render };
})();
