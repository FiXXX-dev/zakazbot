// Страница «Входящие заказы» (index.html):
// список заказов, поиск по клиенту, фильтры по статусу и дате,
// смена статуса, выгрузка Excel, удаление.

(function () {
  const STATUS_LABELS = { new: "Новый", processing: "В работе", ready: "Готов" };

  const els = {
    setup: document.getElementById("setup-warning"),
    list: document.getElementById("orders-list"),
    search: document.getElementById("search-input"),
    status: document.getElementById("status-filter"),
    date: document.getElementById("date-filter"),
    refresh: document.getElementById("refresh-btn")
  };

  let orders = [];
  let userId = null;

  boot();

  function boot() {
    if (!window.sb) {
      els.setup.innerHTML =
        '<div class="msg msg-warn">Supabase не настроен: скопируйте <code>config.example.js</code> в <code>config.js</code> и заполните ключи.</div>';
      els.list.innerHTML = "";
      return;
    }
    window.Auth.guard().then(function (user) {
      if (!user) return; // не залогинен — guard уже перенаправил на login.html
      userId = user.id;
      init();
    });
  }

  function init() {
    els.search.addEventListener("input", render);
    els.status.addEventListener("change", render);
    els.date.addEventListener("change", render);
    els.refresh.addEventListener("click", loadOrders);
    loadOrders();
  }

  async function loadOrders() {
    els.list.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка заказов…</div>';
    const { data, error } = await window.sb
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      els.list.innerHTML = '<div class="msg msg-error">Не удалось загрузить заказы: ' + esc(error.message) + "</div>";
      return;
    }
    orders = data || [];
    render();
  }

  function filtered() {
    const q = els.search.value.trim().toLowerCase();
    const st = els.status.value;
    const dt = els.date.value;
    return orders.filter(function (o) {
      if (st !== "all" && o.status !== st) return false;
      if (dt === "today" && !isToday(o.created_at)) return false;
      if (q &&
          String(o.client_name || "").toLowerCase().indexOf(q) === -1 &&
          String(o.client_phone || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function render() {
    const list = filtered();
    if (!list.length) {
      els.list.innerHTML =
        '<div class="msg msg-info">Заказов не найдено. <a href="new-order.html">Создать новый заказ</a></div>';
      return;
    }
    els.list.innerHTML = "";
    list.forEach(function (o) { els.list.appendChild(orderCard(o)); });
  }

  function orderCard(o) {
    const card = document.createElement("div");
    card.className = "card";
    const itemsCount = Array.isArray(o.items) ? o.items.length : 0;

    const statusOptions = Object.keys(STATUS_LABELS).map(function (s) {
      return '<option value="' + s + '"' + (s === o.status ? " selected" : "") + ">" +
        STATUS_LABELS[s] + "</option>";
    }).join("");

    card.innerHTML =
      '<div class="order-head">' +
        "<div>" +
          '<div class="order-client">' + esc(o.client_name || "Без имени") + "</div>" +
          '<div class="order-meta">' + esc(fmtDate(o.created_at)) +
            (o.client_phone ? " · " + esc(o.client_phone) : "") +
            " · позиций: " + itemsCount + "</div>" +
        "</div>" +
        '<span class="badge badge-' + esc(o.status) + '">' + esc(STATUS_LABELS[o.status] || o.status) + "</span>" +
      "</div>" +
      '<div class="order-items-preview">' + esc(itemsPreview(o.items)) + "</div>" +
      '<div class="order-actions">' +
        '<select class="status-select" title="Сменить статус">' + statusOptions + "</select>" +
        '<button type="button" class="btn btn-outline btn-sm excel-btn">Скачать Excel</button>' +
        '<button type="button" class="btn btn-danger btn-sm delete-btn">Удалить</button>' +
      "</div>";

    card.querySelector(".status-select").addEventListener("change", async function (e) {
      const next = e.target.value;
      const prev = o.status;
      const badge = card.querySelector(".badge");
      o.status = next;
      badge.className = "badge badge-" + next;
      badge.textContent = STATUS_LABELS[next];
      const { error } = await window.sb.from("orders").update({ status: next }).eq("id", o.id);
      if (error) {
        o.status = prev;
        e.target.value = prev;
        badge.className = "badge badge-" + prev;
        badge.textContent = STATUS_LABELS[prev];
        alert("Не удалось сменить статус: " + error.message);
        return;
      }
      // Если активен фильтр по статусу — карточка могла выпасть из выборки.
      if (els.status.value !== "all") render();
    });

    card.querySelector(".excel-btn").addEventListener("click", function () {
      window.ExcelUtils.downloadOrderExcel(o);
    });

    card.querySelector(".delete-btn").addEventListener("click", async function () {
      if (!confirm("Удалить заказ клиента «" + (o.client_name || "Без имени") + "»?")) return;
      const { error } = await window.sb.from("orders").delete().eq("id", o.id);
      if (error) {
        alert("Не удалось удалить: " + error.message);
        return;
      }
      orders = orders.filter(function (x) { return x.id !== o.id; });
      render();
    });

    return card;
  }

  function itemsPreview(items) {
    if (!Array.isArray(items) || !items.length) return "Нет позиций";
    const parts = items.slice(0, 4).map(function (it) {
      let s = it.name || "—";
      if (it.qty != null) s += " — " + it.qty + (it.unit ? " " + it.unit : "");
      return s;
    });
    let txt = parts.join(" · ");
    if (items.length > 4) txt += " · ещё " + (items.length - 4);
    return txt;
  }

  function isToday(iso) {
    const d = new Date(iso);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() &&
           d.getMonth() === n.getMonth() &&
           d.getDate() === n.getDate();
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
