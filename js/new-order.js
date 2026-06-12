// Страница «Новый заказ» (new-order.html):
// распознавание аудио/текста, редактируемая таблица позиций,
// выгрузка Excel, сохранение заказа в Supabase.
//
// КРИТИЧНО (UX): при вводе в ячейки таблица НЕ перерисовывается — обновляются
// только модель данных, ячейка «Сумма» и подсветка строки, иначе сбрасывается
// фокус с инпута. Полная перерисовка — только после распознавания.

(function () {
  const els = {
    setup: document.getElementById("setup-warning"),
    tabs: document.getElementById("mode-tabs"),
    audioPanel: document.getElementById("audio-panel"),
    textPanel: document.getElementById("text-panel"),
    audioFile: document.getElementById("audio-file"),
    orderText: document.getElementById("order-text"),
    transcriptBlock: document.getElementById("transcript-block"),
    transcriptText: document.getElementById("transcript-text"),
    editTranscriptBtn: document.getElementById("edit-transcript-btn"),
    recognizeBtn: document.getElementById("recognize-btn"),
    recognizeMsg: document.getElementById("recognize-msg"),
    flags: document.getElementById("order-flags"),
    tbody: document.getElementById("items-tbody"),
    total: document.getElementById("items-total"),
    addRowBtn: document.getElementById("add-row-btn"),
    clientName: document.getElementById("client-name"),
    clientPhone: document.getElementById("client-phone"),
    clientsDatalist: document.getElementById("clients-datalist"),
    excelBtn: document.getElementById("excel-btn"),
    saveBtn: document.getElementById("save-btn"),
    saveMsg: document.getElementById("save-msg")
  };

  const ALLOWED_AUDIO = /\.(ogg|mp3|wav|m4a)$/i;
  const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // лимит Whisper — 25 МБ

  let mode = "audio";
  let items = [];          // модель таблицы: [{ name, qty, unit, price, confidence, note }]
  let sourceText = "";     // исходный текст / расшифровка — сохраняется в orders.source_text
  let clientsCache = [];
  let lastSavedSignature = null; // защита от случайного двойного сохранения

  init();

  function init() {
    if (!window.sb) {
      els.setup.innerHTML =
        '<div class="msg msg-warn">Supabase не настроен: скопируйте <code>config.example.js</code> в <code>config.js</code> и заполните ключи. Распознавание и сохранение работать не будут.</div>';
    }

    els.tabs.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () { switchMode(btn.dataset.mode); });
    });

    els.recognizeBtn.addEventListener("click", onRecognize);

    els.editTranscriptBtn.addEventListener("click", function () {
      els.orderText.value = els.transcriptText.textContent;
      els.transcriptBlock.classList.add("hidden");
      switchMode("text");
    });

    els.addRowBtn.addEventListener("click", function () {
      const item = normalizeItem({ unit: "шт", confidence: "high" });
      items.push(item);
      els.tbody.appendChild(buildRow(item));
      renumber();
      refreshTotal();
    });

    els.excelBtn.addEventListener("click", onExcel);
    els.saveBtn.addEventListener("click", onSave);
    els.clientName.addEventListener("change", autofillPhone);

    loadClients();
  }

  function switchMode(next) {
    mode = next;
    els.tabs.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mode === next);
    });
    els.audioPanel.classList.toggle("hidden", next !== "audio");
    els.textPanel.classList.toggle("hidden", next !== "text");
  }

  // ── Клиенты (для datalist, автоподстановки телефона и «как обычно») ──

  async function loadClients() {
    if (!window.sb) return;
    const { data, error } = await window.sb
      .from("clients")
      .select("*")
      .order("name", { ascending: true });
    if (error || !data) return;
    clientsCache = data;
    els.clientsDatalist.innerHTML = "";
    data.forEach(function (c) {
      const opt = document.createElement("option");
      opt.value = c.name;
      els.clientsDatalist.appendChild(opt);
    });
  }

  function findClient(name) {
    const q = String(name || "").trim().toLowerCase();
    if (!q) return null;
    return clientsCache.find(function (c) {
      return String(c.name || "").trim().toLowerCase() === q;
    }) || null;
  }

  // Нечёткий поиск клиента: точное совпадение в кэше → ilike по полному имени →
  // ilike по отдельным словам длиннее 3 символов. Регистронезависимо.
  // Пример: «навруз» → находит «Ресторан Навруз».
  async function findClientFuzzy(name) {
    const q = String(name || "").trim();
    if (!q) return null;

    const exact = findClient(q);
    if (exact) return exact;
    if (!window.sb) return null;

    let found = await findClientIlike(q);
    if (found) return found;

    const words = q.split(/\s+/);
    for (const word of words) {
      if (word.length > 3) { // игнорируем короткие слова («ИП», предлоги и т.п.)
        found = await findClientIlike(word);
        if (found) return found;
      }
    }
    return null;
  }

  async function findClientIlike(fragment) {
    const pattern = "%" + String(fragment).replace(/([%_\\])/g, "\\$1") + "%";
    const { data, error } = await window.sb
      .from("clients")
      .select("*")
      .ilike("name", pattern)
      .order("name", { ascending: true })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  }

  function autofillPhone() {
    const client = findClient(els.clientName.value);
    if (client && client.phone && !els.clientPhone.value.trim()) {
      els.clientPhone.value = client.phone;
    }
  }

  // ── Распознавание ──

  async function onRecognize() {
    try {
      let text = "";

      if (mode === "audio") {
        const file = els.audioFile.files[0];
        if (!file) { showMsg(els.recognizeMsg, "warn", "Выберите аудиофайл."); return; }
        if (!ALLOWED_AUDIO.test(file.name)) {
          showMsg(els.recognizeMsg, "warn", "Неподдерживаемый формат. Допустимы: .ogg, .mp3, .wav, .m4a");
          return;
        }
        if (file.size > MAX_AUDIO_SIZE) {
          showMsg(els.recognizeMsg, "warn", "Файл больше 25 МБ — Whisper его не примет.");
          return;
        }
        setBusy("Расшифровываю аудио (Whisper)…");
        text = await window.AI.transcribeAudio(file);
        els.transcriptText.textContent = text;
        els.transcriptBlock.classList.remove("hidden");
        if (!text.trim()) {
          showMsg(els.recognizeMsg, "warn", "Whisper вернул пустой текст. Проверьте запись.");
          return;
        }
      } else {
        els.transcriptBlock.classList.add("hidden");
        text = els.orderText.value.trim();
        if (!text) { showMsg(els.recognizeMsg, "warn", "Введите текст заказа."); return; }
      }

      sourceText = text;
      setBusy("Разбираю заказ (GPT-4o-mini)…");
      const parsed = await window.AI.parseOrder(text);
      await applyParsed(parsed || {});

      if (!items.length) {
        showMsg(els.recognizeMsg, "warn", "Позиции не распознаны. Проверьте текст и попробуйте ещё раз.");
      } else {
        showMsg(els.recognizeMsg, "success",
          "Распознано позиций: " + items.length + ". Жёлтым выделено то, что нужно уточнить.");
      }
    } catch (e) {
      showMsg(els.recognizeMsg, "error", "Ошибка: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.recognizeBtn.disabled = false;
    }
  }

  function setBusy(label) {
    els.recognizeBtn.disabled = true;
    showMsg(els.recognizeMsg, "info", '<span class="spinner"></span> ' + label);
  }

  async function applyParsed(parsed) {
    let newItems = (Array.isArray(parsed.items) ? parsed.items : []).map(normalizeItem);
    const flagsHtml = [];

    let nameAutoFilled = false;
    if (parsed.client_name && !els.clientName.value.trim()) {
      els.clientName.value = String(parsed.client_name);
      nameAutoFilled = true;
    }

    // Нечёткий поиск клиента в базе («навруз» → «Ресторан Навруз»).
    const client = await findClientFuzzy(els.clientName.value);
    if (client) {
      // Каноническое имя из базы: по нему связывается история заказов.
      if (nameAutoFilled) els.clientName.value = client.name;
      if (client.phone && !els.clientPhone.value.trim()) els.clientPhone.value = client.phone;
    }

    if (parsed.urgent) {
      flagsHtml.push('<span class="badge badge-urgent">Срочный заказ</span>');
    }
    if (parsed.client_comment) {
      flagsHtml.push('<div class="client-sub">Комментарий клиента: ' + esc(parsed.client_comment) + "</div>");
    }

    // «Как обычно» — подставляем стандартный заказ клиента из базы.
    if (parsed.repeat_last_order) {
      const std = client && Array.isArray(client.standard_order) ? client.standard_order : [];
      if (std.length) {
        const stdItems = std.map(function (it) {
          return normalizeItem(Object.assign({}, it, { confidence: "high", note: "" }));
        });
        newItems = stdItems.concat(newItems);
        flagsHtml.push('<div class="msg msg-info">Клиент просит «как обычно» — подставлен стандартный заказ клиента «' +
          esc(client.name) + "».</div>");
      } else if (client) {
        flagsHtml.push('<div class="msg msg-warn">Клиент «' + esc(client.name) +
          '» найден, но стандартный заказ у него не задан — задайте его на странице «Клиенты».</div>');
      } else {
        flagsHtml.push('<div class="msg msg-warn">Клиент просит «как обычно», но клиент в базе не найден. ' +
          'Проверьте имя или добавьте клиента на странице «Клиенты».</div>');
      }
    }

    els.flags.innerHTML = flagsHtml.join(" ");
    items = newItems;
    renderItemsTable();
  }

  function normalizeItem(it) {
    it = it || {};
    const qty = it.qty == null || it.qty === "" || isNaN(Number(it.qty)) ? null : Number(it.qty);
    const price = it.price == null || it.price === "" || isNaN(Number(it.price)) ? null : Number(it.price);
    return {
      name: it.name ? String(it.name) : "",
      qty: qty,
      unit: it.unit ? String(it.unit) : "шт",
      price: price,
      confidence: it.confidence === "low" || it.confidence === "medium" ? it.confidence : "high",
      note: it.note ? String(it.note) : ""
    };
  }

  // ── Таблица позиций ──

  function renderItemsTable() {
    els.tbody.innerHTML = "";
    items.forEach(function (item) { els.tbody.appendChild(buildRow(item)); });
    renumber();
    refreshTotal();
  }

  function buildRow(item) {
    const tr = document.createElement("tr");

    const tdNum = document.createElement("td");
    tdNum.className = "num";

    const tdName = document.createElement("td");
    const nameInp = cellInput("text");
    nameInp.placeholder = "Наименование";
    nameInp.value = item.name || "";
    const noteDiv = document.createElement("div");
    noteDiv.className = "item-note";
    noteDiv.textContent = item.note || "";
    tdName.appendChild(nameInp);
    tdName.appendChild(noteDiv);

    const tdQty = document.createElement("td");
    const qtyInp = cellInput("number");
    qtyInp.placeholder = "?";
    if (item.qty != null) qtyInp.value = item.qty;
    tdQty.appendChild(qtyInp);

    const tdUnit = document.createElement("td");
    const unitInp = cellInput("text");
    unitInp.setAttribute("list", "units-datalist");
    unitInp.value = item.unit || "";
    tdUnit.appendChild(unitInp);

    const tdPrice = document.createElement("td");
    const priceInp = cellInput("number");
    if (item.price != null) priceInp.value = item.price;
    tdPrice.appendChild(priceInp);

    const tdSum = document.createElement("td");
    tdSum.className = "sum";

    const tdDel = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-del";
    delBtn.title = "Удалить строку";
    delBtn.textContent = "×";
    tdDel.appendChild(delBtn);

    tr.append(tdNum, tdName, tdQty, tdUnit, tdPrice, tdSum, tdDel);

    // Обновляем ТОЛЬКО модель, ячейку «Сумма» и подсветку — фокус не сбрасывается.
    nameInp.addEventListener("input", function () {
      item.name = nameInp.value;
      if (item.confidence === "low") {
        // Менеджер поправил название — уточнение снято.
        item.confidence = "high";
        item.note = "";
        noteDiv.textContent = "";
      }
      refreshRowState();
    });
    qtyInp.addEventListener("input", function () {
      item.qty = qtyInp.value === "" ? null : Number(qtyInp.value);
      refreshRowState();
      refreshTotal();
    });
    unitInp.addEventListener("input", function () {
      item.unit = unitInp.value;
    });
    priceInp.addEventListener("input", function () {
      item.price = priceInp.value === "" ? null : Number(priceInp.value);
      refreshRowState();
      refreshTotal();
    });
    delBtn.addEventListener("click", function () {
      const idx = items.indexOf(item);
      if (idx !== -1) items.splice(idx, 1);
      tr.remove();
      renumber();
      refreshTotal();
    });

    function refreshRowState() {
      tr.classList.toggle("row-warn", item.confidence === "low" || item.qty == null);
      const sum = rowSum(item);
      tdSum.textContent = sum == null ? "—" : fmtNum(sum);
    }

    refreshRowState();
    return tr;
  }

  function cellInput(type) {
    const inp = document.createElement("input");
    inp.type = type;
    inp.className = "cell-input";
    if (type === "number") {
      inp.min = "0";
      inp.step = "any";
    }
    return inp;
  }

  function rowSum(item) {
    return item.qty != null && item.price != null ? item.qty * item.price : null;
  }

  function renumber() {
    els.tbody.querySelectorAll("td.num").forEach(function (td, i) {
      td.textContent = i + 1;
    });
  }

  function refreshTotal() {
    let total = 0;
    items.forEach(function (it) {
      const s = rowSum(it);
      if (s != null) total += s;
    });
    els.total.textContent = fmtNum(total);
  }

  // ── Excel и сохранение ──

  function currentOrder() {
    return {
      client_name: els.clientName.value.trim(),
      client_phone: els.clientPhone.value.trim(),
      items: items.filter(function (it) { return String(it.name || "").trim() !== ""; })
    };
  }

  function onExcel() {
    const order = currentOrder();
    if (!order.items.length) {
      showMsg(els.saveMsg, "warn", "Нет позиций для выгрузки.");
      return;
    }
    els.saveMsg.innerHTML = "";
    window.ExcelUtils.downloadOrderExcel(order);
  }

  async function onSave() {
    if (!window.sb) {
      showMsg(els.saveMsg, "error", "Supabase не настроен (config.js) — сохранение недоступно.");
      return;
    }
    const order = currentOrder();
    if (!order.items.length) { showMsg(els.saveMsg, "warn", "Добавьте хотя бы одну позицию."); return; }
    if (!order.client_name) { showMsg(els.saveMsg, "warn", "Укажите клиента."); return; }

    const payload = {
      client_name: order.client_name,
      client_phone: order.client_phone || null,
      status: "new",
      items: order.items,
      source_text: sourceText || (mode === "text" ? els.orderText.value.trim() : "") || null
    };

    const signature = JSON.stringify(payload);
    if (signature === lastSavedSignature &&
        !confirm("Этот заказ уже сохранён. Сохранить ещё раз?")) {
      return;
    }

    els.saveBtn.disabled = true;
    try {
      const { error } = await window.sb.from("orders").insert(payload);
      if (error) throw new Error(error.message);
      lastSavedSignature = signature;
      await upsertClient(order.client_name, order.client_phone);
      showMsg(els.saveMsg, "success", 'Заказ сохранён. <a href="index.html">Перейти к заказам</a>');
    } catch (e) {
      showMsg(els.saveMsg, "error", "Не удалось сохранить: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.saveBtn.disabled = false;
    }
  }

  // Пополняем базу клиентов при сохранении заказа (не критично при ошибке).
  async function upsertClient(name, phone) {
    try {
      const existing = findClient(name);
      if (existing) {
        if (phone && !existing.phone) {
          await window.sb.from("clients").update({ phone: phone }).eq("id", existing.id);
          existing.phone = phone;
        }
        return;
      }
      const { data } = await window.sb
        .from("clients")
        .insert({ name: name, phone: phone || null })
        .select()
        .single();
      if (data) {
        clientsCache.push(data);
        const opt = document.createElement("option");
        opt.value = data.name;
        els.clientsDatalist.appendChild(opt);
      }
    } catch (e) {
      console.warn("[ZakazBot] Не удалось сохранить клиента:", e);
    }
  }

  // ── Утилиты ──

  function showMsg(el, type, html) {
    el.innerHTML = '<div class="msg msg-' + type + '">' + html + "</div>";
  }

  function fmtNum(n) {
    return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
