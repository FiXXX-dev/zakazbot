// Аналитика для тарифа Pro (вкладка на clients.html). Chart.js с CDN.
//
// window.Analytics.render(container, userId):
//   • переключатель периода (30 / 90 дней / всё время);
//   • KPI-сводка: заказов, выручка, средний чек, активных клиентов;
//   • выручка по дням, заказы по дням, заказы по статусам;
//   • топ клиентов и товаров по выручке, топ товаров по количеству.
// Заказы грузятся один раз, период пересчитывается на клиенте (без рефетча).

(function () {
  const ACCENT = "#0d7d6f";
  const ORANGE = "#b26a00";
  const STATUS = { new: ["Новый", "#0d7d6f"], processing: ["В работе", "#e0892b"], ready: ["Готов", "#3a9e5f"] };

  let charts = [];
  let allOrders = [];
  let period = "30";

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
  function dayLabel(key) { const p = key.split("-"); return p[2] + "." + p[1]; }

  // Начало периода (timestamp): "all" → 0, иначе последние N дней включительно.
  function periodStart(p) {
    if (p === "all") return 0;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(p) - 1));
    return d.getTime();
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
      .select("created_at, client_name, items, status")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      container.innerHTML = '<div class="msg msg-error">Не удалось загрузить аналитику: ' + esc(error.message) + "</div>";
      return;
    }
    allOrders = data || [];
    if (!allOrders.length) {
      container.innerHTML = '<div class="msg msg-info">Пока нет заказов для аналитики.</div>';
      return;
    }

    // Каркас: переключатель периода + тело (KPI и графики).
    container.innerHTML =
      '<div class="tabs analytics-controls" id="an-period">' +
        '<button type="button" data-p="30">30 дней</button>' +
        '<button type="button" data-p="90">90 дней</button>' +
        '<button type="button" data-p="all">Всё время</button>' +
      "</div>" +
      '<div id="an-body"></div>';

    const bar = container.querySelector("#an-period");
    bar.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        period = btn.dataset.p;
        draw(container);
      });
    });
    draw(container);
  }

  function draw(container) {
    destroy();
    const body = container.querySelector("#an-body");
    container.querySelectorAll("#an-period button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.p === period);
    });

    const start = periodStart(period);
    const orders = allOrders.filter(function (o) { return new Date(o.created_at).getTime() >= start; });

    // ── Агрегации ──
    const byDayCount = {}, byDayRev = {}, byClientRev = {}, byProductQty = {}, byProductRev = {}, byStatus = {};
    let revenue = 0;
    const clientSet = {};
    orders.forEach(function (o) {
      const k = dayKey(o.created_at);
      const sum = orderSum(o.items);
      revenue += sum;
      byDayCount[k] = (byDayCount[k] || 0) + 1;
      byDayRev[k] = (byDayRev[k] || 0) + sum;
      const name = String(o.client_name || "Без имени").trim();
      byClientRev[name] = (byClientRev[name] || 0) + sum;
      clientSet[name.toLowerCase()] = true;
      const st = STATUS[o.status] ? o.status : "new";
      byStatus[st] = (byStatus[st] || 0) + 1;
      (Array.isArray(o.items) ? o.items : []).forEach(function (it) {
        const key = String((it && it.name) || "").trim().toLowerCase();
        if (!key) return;
        const q = Number(it && it.qty);
        const p = Number(it && it.price);
        byProductQty[key] = (byProductQty[key] || 0) + (isFinite(q) ? q : 0);
        byProductRev[key] = (byProductRev[key] || 0) + (isFinite(q) && isFinite(p) ? q * p : 0);
      });
    });

    // ── KPI ──
    const ordersCount = orders.length;
    const clientsCount = Object.keys(clientSet).length;
    const avg = ordersCount ? revenue / ordersCount : 0;
    const kpis = [
      ["Заказов", String(ordersCount)],
      ["Выручка", fmtMoney(revenue)],
      ["Средний чек", fmtMoney(avg)],
      ["Активных клиентов", String(clientsCount)]
    ];
    let html = '<div class="kpi-grid">';
    kpis.forEach(function (k) {
      html += '<div class="kpi"><div class="kpi-label">' + esc(k[0]) + '</div><div class="kpi-value">' + esc(k[1]) + "</div></div>";
    });
    html += "</div>";

    if (!ordersCount) {
      body.innerHTML = html + '<div class="msg msg-info">За выбранный период заказов нет.</div>';
      return;
    }

    // ── Разметка графиков ──
    html +=
      '<div class="charts-grid">' +
        '<div class="card chart-wide"><h3>Выручка по дням</h3><canvas id="ch-rev" height="100"></canvas></div>' +
        '<div class="card"><h3>Заказы по дням</h3><canvas id="ch-days" height="200"></canvas></div>' +
        '<div class="card"><h3>Заказы по статусам</h3><canvas id="ch-status" height="200"></canvas></div>' +
        '<div class="card"><h3>Топ-7 клиентов по выручке</h3><canvas id="ch-clients" height="220"></canvas></div>' +
        '<div class="card"><h3>Топ-10 товаров по выручке</h3><canvas id="ch-prod-rev" height="240"></canvas></div>' +
        '<div class="card"><h3>Топ-10 товаров по количеству</h3><canvas id="ch-prod-qty" height="240"></canvas></div>' +
      "</div>";
    body.innerHTML = html;

    const days = Object.keys(byDayCount).sort();
    const labels = days.map(dayLabel);
    const topClients = topN(byClientRev, 7);
    const topProdRev = topN(byProductRev, 10);
    const topProdQty = topN(byProductQty, 10);

    charts.push(new Chart(body.querySelector("#ch-rev"), barCfg(
      labels, days.map(function (d) { return round2(byDayRev[d]); }), "Выручка", ACCENT, false
    )));
    charts.push(new Chart(body.querySelector("#ch-days"), barCfg(
      labels, days.map(function (d) { return byDayCount[d]; }), "Заказов", ACCENT, false
    )));

    const stKeys = Object.keys(byStatus);
    charts.push(new Chart(body.querySelector("#ch-status"), doughnutCfg(
      stKeys.map(function (s) { return STATUS[s][0]; }),
      stKeys.map(function (s) { return byStatus[s]; }),
      stKeys.map(function (s) { return STATUS[s][1]; })
    )));

    charts.push(new Chart(body.querySelector("#ch-clients"), barCfg(
      topClients.map(kv), topClients.map(kvv), "Выручка", ACCENT, true
    )));
    charts.push(new Chart(body.querySelector("#ch-prod-rev"), barCfg(
      topProdRev.map(kv), topProdRev.map(kvv), "Выручка", ACCENT, true
    )));
    charts.push(new Chart(body.querySelector("#ch-prod-qty"), barCfg(
      topProdQty.map(kv), topProdQty.map(kvv), "Количество", ORANGE, true
    )));
  }

  function topN(obj, n) {
    return Object.keys(obj)
      .map(function (k) { return [k, obj[k]]; })
      .filter(function (p) { return p[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, n);
  }
  function kv(pair) { return pair[0]; }
  function kvv(pair) { return round2(pair[1]); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtMoney(n) { return Math.round(n).toLocaleString("ru-RU"); }

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

  function doughnutCfg(labels, values, colors) {
    return {
      type: "doughnut",
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }] },
      options: { responsive: true, plugins: { legend: { position: "bottom" } } }
    };
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.Analytics = { render: render };
})();
