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
    cfMsg: document.getElementById("cf-msg"),
    tabs: document.getElementById("view-tabs"),
    tabAnalytics: document.getElementById("tab-analytics"),
    clientsView: document.getElementById("clients-view"),
    telegramView: document.getElementById("telegram-view"),
    analyticsView: document.getElementById("analytics-view")
  };

  let clients = [];
  let editingId = null;
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
      if (!user) return;
      userId = user.id;
      init();
    });
  }

  function init() {
    els.search.addEventListener("input", render);
    els.addBtn.addEventListener("click", function () { openForm(null); });
    els.cfSave.addEventListener("click", saveForm);
    els.cfCancel.addEventListener("click", closeForm);
    setupTabs();
    loadClients();
  }

  // Вкладка «Аналитика» — только для тарифа Pro.
  function setupTabs() {
    if (window.Plan && window.Plan.isPro()) els.tabAnalytics.style.display = "";
    els.tabs.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () { switchView(btn.dataset.view, btn); });
    });
  }

  function switchView(view, btn) {
    els.tabs.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b === btn); });
    els.clientsView.classList.toggle("hidden", view !== "clients");
    els.telegramView.classList.toggle("hidden", view !== "telegram");
    els.analyticsView.classList.toggle("hidden", view !== "analytics");
    if (view === "analytics" && window.Analytics) window.Analytics.render(els.analyticsView, userId);
    if (view === "telegram") loadTelegram();
  }

  async function loadClients() {
    els.list.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка клиентов…</div>';
    const { data, error } = await window.sb
      .from("clients")
      .select("*")
      .eq("user_id", userId)
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
      .eq("user_id", userId)
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

    // Импорт из файла: парсим .xlsx/.csv и добавляем позиции в таблицу
    // (не сохраняя — пользователь проверяет и жмёт «Сохранить»).
    const imp = document.createElement("div");
    imp.style.cssText = "margin:8px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    const impFile = document.createElement("input");
    impFile.type = "file";
    impFile.accept = ".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";
    impFile.style.maxWidth = "260px";
    const impBtn = document.createElement("button");
    impBtn.type = "button";
    impBtn.className = "btn btn-outline btn-sm";
    impBtn.textContent = "Загрузить из файла";
    const impHint = document.createElement("span");
    impHint.className = "client-sub";
    impHint.textContent = "Колонки: Наименование, Количество, Ед.изм., Цена (цена необязательна)";
    imp.appendChild(impFile);
    imp.appendChild(impBtn);
    imp.appendChild(impHint);
    box.insertBefore(imp, wrap);

    impBtn.addEventListener("click", async function () {
      const file = impFile.files[0];
      if (!file) { msg.innerHTML = '<div class="msg msg-warn">Выберите файл (.csv или .xlsx).</div>'; return; }
      if (typeof XLSX === "undefined") {
        msg.innerHTML = '<div class="msg msg-error">Библиотека для чтения файлов не загрузилась (проверьте доступ к CDN).</div>';
        return;
      }
      impBtn.disabled = true;
      try {
        const rows = await readStdRows(file);
        let added = 0, skipped = 0;
        rows.forEach(function (r) {
          const name = String(pickCol(r, ["Наименование", "Название", "Товар", "name"]) || "").trim();
          if (!name) { skipped++; return; }
          const it = normalizeStdItem({
            name: name,
            qty: parseNum(pickCol(r, ["Количество", "Кол-во", "Кол", "qty", "Quantity"])),
            unit: String(pickCol(r, ["Ед.изм.", "Единица", "Единица измерения", "unit"]) || "").trim() || "шт",
            price: parseNum(pickCol(r, ["Цена", "price"]))
          });
          std.push(it);
          addRow(it);
          added++;
        });
        if (added) {
          msg.innerHTML = '<div class="msg msg-success">Добавлено позиций из файла: ' + added +
            (skipped ? " (пропущено без названия: " + skipped + ")" : "") +
            ". Проверьте таблицу и нажмите «Сохранить стандартный заказ».</div>";
        } else {
          msg.innerHTML = '<div class="msg msg-warn">Не найдено ни одной позиции. Проверьте, что в первой строке файла есть колонка «Наименование».</div>';
        }
        impFile.value = "";
      } catch (e) {
        msg.innerHTML = '<div class="msg msg-error">Ошибка чтения файла: ' + esc(e && e.message ? e.message : String(e)) + "</div>";
      } finally {
        impBtn.disabled = false;
      }
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

  // ── Импорт стандартного заказа из файла (.xlsx/.csv через SheetJS) ──

  async function readStdRows(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return ws ? XLSX.utils.sheet_to_json(ws, { defval: "" }) : [];
  }

  // Значение строки по одному из возможных заголовков (без учёта регистра/пробелов).
  function pickCol(row, candidates) {
    const keys = Object.keys(row);
    for (let i = 0; i < candidates.length; i++) {
      const want = candidates[i].trim().toLowerCase();
      for (let j = 0; j < keys.length; j++) {
        if (keys[j].trim().toLowerCase() === want) return row[keys[j]];
      }
    }
    return undefined;
  }

  // «1 200,5» → 1200.5; пусто/мусор → null.
  function parseNum(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : null;
  }

  // ── Telegram-клиенты (привязка ТГ-чатов к клиентам базы) ──
  // Бот сохраняет @username/имя чата; здесь менеджер привязывает чат кафе к
  // карточке клиента из базы → telegram_links.client_name (каноничное имя).
  // Тогда бот подставляет стандартный заказ и цены этого клиента.

  async function loadTelegram() {
    els.telegramView.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка Telegram-клиентов…</div>';
    const { data, error } = await window.sb
      .from("telegram_links")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) {
      els.telegramView.innerHTML = '<div class="msg msg-error">Не удалось загрузить Telegram-клиентов: ' + esc(error.message) + "</div>";
      return;
    }
    renderTelegram(data || []);
  }

  function renderTelegram(links) {
    els.telegramView.innerHTML = "";

    const hint = document.createElement("p");
    hint.className = "client-sub";
    hint.textContent = "Чаты, подключённые к боту. Привяжите чат кафе к клиенту из базы — " +
      "тогда бот будет подставлять его стандартный заказ и цены.";
    els.telegramView.appendChild(hint);

    if (!links.length) {
      const m = document.createElement("div");
      m.className = "msg msg-info";
      m.textContent = "Пока никто не подключился через Telegram. Отправьте кафе ссылку-приглашение из админ-панели, а менеджеру — ключ доступа.";
      els.telegramView.appendChild(m);
      return;
    }
    links.forEach(function (l) { els.telegramView.appendChild(tgCard(l)); });
  }

  function tgCard(l) {
    const card = document.createElement("div");
    card.className = "card";
    const isCustomer = l.role === "customer";
    const display = [l.tg_first_name, l.tg_last_name].filter(Boolean).join(" ") ||
      (isCustomer ? "Кафе" : "Менеджер");
    const uname = l.tg_username ? "@" + l.tg_username : "username не указан";
    const roleLabel = isCustomer ? "Кафе" : "Менеджер";
    const roleBadge = isCustomer ? "badge-processing" : "badge-new";
    const unameHtml = l.tg_username
      ? '<a href="https://t.me/' + esc(l.tg_username) + '" target="_blank" rel="noopener">' + esc(uname) + "</a>"
      : esc(uname);

    card.innerHTML =
      '<div class="client-head">' +
        "<div>" +
          '<div class="client-name">' + esc(display) +
            ' <span class="badge ' + roleBadge + '">' + roleLabel + "</span></div>" +
          '<div class="client-sub">' + unameHtml + " · чат " + esc(String(l.chat_id)) + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="tg-bind" style="margin-top:12px"></div>';

    const bind = card.querySelector(".tg-bind");

    if (!isCustomer) {
      // Менеджер-оператор определяет клиента по речи — фиксированная привязка не нужна.
      const note = document.createElement("p");
      note.className = "client-sub";
      note.style.margin = "0";
      note.textContent = "Менеджер-оператор поставщика. Клиента бот определяет по речи — привязка не требуется.";
      bind.appendChild(note);
      return card;
    }

    const label = document.createElement("label");
    label.textContent = "Клиент в базе:";
    label.style.marginRight = "8px";
    const sel = tgClientSelect(l.client_name);
    const msg = document.createElement("span");
    msg.style.marginLeft = "10px";
    msg.style.fontSize = "13px";

    sel.addEventListener("change", async function () {
      const val = sel.value;
      sel.disabled = true;
      msg.textContent = "Сохранение…";
      const { error } = await window.sb
        .from("telegram_links")
        .update({ client_name: val || null })
        .eq("chat_id", l.chat_id);
      sel.disabled = false;
      if (error) {
        msg.innerHTML = '<span style="color:var(--danger)">Ошибка: ' + esc(error.message) + "</span>";
        return;
      }
      l.client_name = val || null;
      msg.innerHTML = '<span style="color:var(--ok)">Сохранено ✓</span>';
    });

    bind.appendChild(label);
    bind.appendChild(sel);
    bind.appendChild(msg);
    return card;
  }

  // Выпадающий список клиентов базы; current — текущее client_name привязки.
  function tgClientSelect(current) {
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— не привязан —";
    sel.appendChild(none);

    let found = false;
    clients.forEach(function (c) {
      const o = document.createElement("option");
      o.value = c.name;
      o.textContent = c.name;
      if (current && c.name === current) { o.selected = true; found = true; }
      sel.appendChild(o);
    });
    // client_name задан, но такого клиента нет в базе — показываем как есть.
    if (current && !found) {
      const o = document.createElement("option");
      o.value = current;
      o.textContent = current + " (нет в базе)";
      o.selected = true;
      sel.appendChild(o);
    }
    return sel;
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
      notes: els.cfNotes.value.trim() || null,
      user_id: userId
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
