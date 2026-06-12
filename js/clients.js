// Страница «База клиентов» (clients.html):
// список клиентов с поиском, добавление/редактирование/удаление,
// история заказов и стандартный заказ (подставляется на «как обычно»).

(function () {
  const STATUS_LABELS = { new: "Новый", processing: "В работе", ready: "Готов" };

  const els = {
    setup: document.getElementById("setup-warning"),
    list: document.getElementById("clients-list"),
    search: document.getElementById("search-input"),
    addBtn: document.getElementById("add-client-btn"),
    form: document.getElementById("client-form"),
    formTitle: document.getElementById("client-form-title"),
    cfName: document.getElementById("cf-name"),
    cfPhone: document.getElementById("cf-phone"),
    cfNotes: document.getElementById("cf-notes"),
    cfSave: document.getElementById("cf-save"),
    cfCancel: document.getElementById("cf-cancel"),
    cfMsg: document.getElementById("cf-msg")
  };

  let clients = [];
  let editingId = null;

  init();

  function init() {
    if (!window.sb) {
      els.setup.innerHTML =
        '<div class="msg msg-warn">Supabase не настроен: скопируйте <code>config.example.js</code> в <code>config.js</code> и заполните ключи.</div>';
      els.list.innerHTML = "";
      return;
    }
    els.search.addEventListener("input", render);
    els.addBtn.addEventListener("click", function () { openForm(null); });
    els.cfSave.addEventListener("click", saveForm);
    els.cfCancel.addEventListener("click", closeForm);
    loadClients();
  }

  async function loadClients() {
    els.list.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка клиентов…</div>';
    const { data, error } = await window.sb
      .from("clients")
      .select("*")
      .order("name", { ascending: true });
    if (error) {
      els.list.innerHTML = '<div class="msg msg-error">Не удалось загрузить клиентов: ' + esc(error.message) + "</div>";
      return;
    }
    clients = data || [];
    render();
  }

  function render() {
    const q = els.search.value.trim().toLowerCase();
    const list = clients.filter(function (c) {
      if (!q) return true;
      return String(c.name || "").toLowerCase().indexOf(q) !== -1 ||
             String(c.phone || "").toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) {
      els.list.innerHTML = '<div class="msg msg-info">Клиентов не найдено. Добавьте первого клиента.</div>';
      return;
    }
    els.list.innerHTML = "";
    list.forEach(function (c) { els.list.appendChild(clientCard(c)); });
  }

  function clientCard(c) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="client-head">' +
        "<div>" +
          '<div class="client-name">' + esc(c.name) + "</div>" +
          '<div class="client-sub">' + esc(c.phone || "Телефон не указан") +
            (c.notes ? " · " + esc(c.notes) : "") + "</div>" +
        "</div>" +
        '<div class="order-actions" style="margin-top:0">' +
          '<button type="button" class="btn btn-outline btn-sm history-btn">История заказов</button>' +
          '<button type="button" class="btn btn-outline btn-sm std-btn">Стандартный заказ</button>' +
          '<button type="button" class="btn btn-outline btn-sm edit-btn">Изменить</button>' +
          '<button type="button" class="btn btn-danger btn-sm del-btn">Удалить</button>' +
        "</div>" +
      "</div>" +
      '<div class="client-details hidden"></div>';

    const details = card.querySelector(".client-details");
    let open = null; // "history" | "std" | null

    function toggle(kind, renderFn) {
      if (open === kind) {
        details.classList.add("hidden");
        details.innerHTML = "";
        open = null;
        return;
      }
      open = kind;
      details.classList.remove("hidden");
      renderFn(c, details);
    }

    card.querySelector(".history-btn").addEventListener("click", function () {
      toggle("history", showHistory);
    });
    card.querySelector(".std-btn").addEventListener("click", function () {
      toggle("std", showStandard);
    });
    card.querySelector(".edit-btn").addEventListener("click", function () {
      openForm(c);
    });
    card.querySelector(".del-btn").addEventListener("click", async function () {
      if (!confirm("Удалить клиента «" + c.name + "»? История его заказов останется.")) return;
      const { error } = await window.sb.from("clients").delete().eq("id", c.id);
      if (error) {
        alert("Не удалось удалить: " + error.message);
        return;
      }
      clients = clients.filter(function (x) { return x.id !== c.id; });
      render();
    });

    return card;
  }

  // ── История заказов клиента ──

  async function showHistory(c, box) {
    box.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка истории…</div>';
    // Заказы связаны с клиентом по имени (MVP, без FK). ilike — без учёта регистра.
    const pattern = String(c.name).replace(/([%_\\])/g, "\\$1");
    const { data, error } = await window.sb
      .from("orders")
      .select("*")
      .ilike("client_name", pattern)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      box.innerHTML = '<div class="msg msg-error">Не удалось загрузить историю: ' + esc(error.message) + "</div>";
      return;
    }
    if (!data || !data.length) {
      box.innerHTML = '<div class="msg msg-info">Заказов пока нет.</div>';
      return;
    }

    box.innerHTML = "";
    data.forEach(function (o) {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML =
        "<span>" + esc(fmtDate(o.created_at)) + "</span>" +
        '<span class="badge badge-' + esc(o.status) + '">' + esc(STATUS_LABELS[o.status] || o.status) + "</span>" +
        '<span class="history-preview">' + esc(itemsPreview(o.items)) + "</span>" +
        '<span class="history-actions">' +
          '<button type="button" class="btn btn-outline btn-sm h-excel">Excel</button>' +
          '<button type="button" class="btn btn-outline btn-sm h-std" title="Сохранить состав как стандартный заказ">Сделать стандартным</button>' +
        "</span>";

      row.querySelector(".h-excel").addEventListener("click", function () {
        window.ExcelUtils.downloadOrderExcel(o);
      });

      row.querySelector(".h-std").addEventListener("click", async function (e) {
        const btn = e.target;
        const { error } = await window.sb
          .from("clients")
          .update({ standard_order: o.items || [] })
          .eq("id", c.id);
        if (error) {
          alert("Не удалось сохранить: " + error.message);
          return;
        }
        c.standard_order = o.items || [];
        btn.textContent = "Сохранено ✓";
        btn.disabled = true;
      });

      box.appendChild(row);
    });
  }

  // ── Стандартный заказ («как обычно») ──

  function showStandard(c, box) {
    box.innerHTML = "";

    const hint = document.createElement("p");
    hint.className = "client-sub";
    hint.textContent = "Стандартный заказ подставляется автоматически, когда клиент говорит «как обычно».";
    box.appendChild(hint);

    let std = (Array.isArray(c.standard_order) ? c.standard_order : []).map(normalizeStdItem);

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.className = "items-table";
    table.innerHTML =
      "<thead><tr><th>Наименование</th><th>Количество</th><th>Ед.изм.</th><th>Цена</th><th></th></tr></thead><tbody></tbody>";
    const tbody = table.querySelector("tbody");
    wrap.appendChild(table);
    box.appendChild(wrap);

    function addRow(it) {
      const tr = document.createElement("tr");

      function cell(type, key) {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.type = type;
        inp.className = "cell-input";
        if (type === "number") {
          inp.min = "0";
          inp.step = "any";
        }
        if (key === "unit") inp.setAttribute("list", "units-datalist");
        inp.value = it[key] == null ? "" : it[key];
        inp.addEventListener("input", function () {
          it[key] = type === "number"
            ? (inp.value === "" ? null : Number(inp.value))
            : inp.value;
        });
        td.appendChild(inp);
        return td;
      }

      tr.appendChild(cell("text", "name"));
      tr.appendChild(cell("number", "qty"));
      tr.appendChild(cell("text", "unit"));
      tr.appendChild(cell("number", "price"));

      const tdDel = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "row-del";
      del.title = "Удалить строку";
      del.textContent = "×";
      del.addEventListener("click", function () {
        std = std.filter(function (x) { return x !== it; });
        tr.remove();
      });
      tdDel.appendChild(del);
      tr.appendChild(tdDel);

      tbody.appendChild(tr);
    }

    std.forEach(addRow);

    const actions = document.createElement("div");
    actions.className = "order-actions";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-outline btn-sm";
    addBtn.textContent = "+ Добавить строку";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-sm";
    saveBtn.textContent = "Сохранить стандартный заказ";
    actions.appendChild(addBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);

    const msg = document.createElement("div");
    box.appendChild(msg);

    addBtn.addEventListener("click", function () {
      const it = normalizeStdItem({ unit: "шт" });
      std.push(it);
      addRow(it);
    });

    saveBtn.addEventListener("click", async function () {
      const cleaned = std.filter(function (it) { return String(it.name || "").trim() !== ""; });
      saveBtn.disabled = true;
      const { error } = await window.sb
        .from("clients")
        .update({ standard_order: cleaned })
        .eq("id", c.id);
      saveBtn.disabled = false;
      if (error) {
        msg.innerHTML = '<div class="msg msg-error">Не удалось сохранить: ' + esc(error.message) + "</div>";
        return;
      }
      c.standard_order = cleaned;
      msg.innerHTML = '<div class="msg msg-success">Стандартный заказ сохранён.</div>';
    });
  }

  function normalizeStdItem(it) {
    it = it || {};
    return {
      name: it.name ? String(it.name) : "",
      qty: it.qty == null || it.qty === "" || isNaN(Number(it.qty)) ? null : Number(it.qty),
      unit: it.unit ? String(it.unit) : "шт",
      price: it.price == null || it.price === "" || isNaN(Number(it.price)) ? null : Number(it.price)
    };
  }

  // ── Форма добавления/редактирования ──

  function openForm(c) {
    editingId = c ? c.id : null;
    els.formTitle.textContent = c ? "Изменить клиента" : "Новый клиент";
    els.cfName.value = c ? c.name : "";
    els.cfPhone.value = c && c.phone ? c.phone : "";
    els.cfNotes.value = c && c.notes ? c.notes : "";
    els.cfMsg.innerHTML = "";
    els.form.classList.remove("hidden");
    els.cfName.focus();
  }

  function closeForm() {
    editingId = null;
    els.form.classList.add("hidden");
    els.cfMsg.innerHTML = "";
  }

  async function saveForm() {
    const name = els.cfName.value.trim();
    if (!name) {
      els.cfMsg.innerHTML = '<div class="msg msg-warn">Укажите название или имя клиента.</div>';
      return;
    }
    const payload = {
      name: name,
      phone: els.cfPhone.value.trim() || null,
      notes: els.cfNotes.value.trim() || null
    };
    els.cfSave.disabled = true;
    const result = editingId
      ? await window.sb.from("clients").update(payload).eq("id", editingId)
      : await window.sb.from("clients").insert(payload);
    els.cfSave.disabled = false;
    if (result.error) {
      els.cfMsg.innerHTML = '<div class="msg msg-error">Не удалось сохранить: ' + esc(result.error.message) + "</div>";
      return;
    }
    closeForm();
    loadClients();
  }

  // ── Утилиты ──

  function itemsPreview(items) {
    if (!Array.isArray(items) || !items.length) return "Нет позиций";
    const parts = items.slice(0, 3).map(function (it) {
      let s = it.name || "—";
      if (it.qty != null) s += " — " + it.qty + (it.unit ? " " + it.unit : "");
      return s;
    });
    let txt = parts.join(" · ");
    if (items.length > 3) txt += " · ещё " + (items.length - 3);
    return txt;
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
