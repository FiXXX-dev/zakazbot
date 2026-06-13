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
    normalizedText: document.getElementById("normalized-text"),
    correctionsList: document.getElementById("corrections-list"),
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
  const AUDIO_BUCKET = "order-audio";      // бакет Supabase Storage для логирования аудио
  const REVIEW_THRESHOLD = 60;             // confidence_score ниже — позиция требует проверки

  let mode = "audio";
  let items = [];          // модель таблицы: [{ name, qty, unit, price, confidence, confidence_score, corrected, note }]
  let sourceText = "";     // нормализованный текст / расшифровка — сохраняется в orders.source_text
  let clientsCache = [];
  let lastSavedSignature = null; // защита от случайного двойного сохранения
  // Данные последнего распознавания — для логирования в order_logs при сохранении.
  let lastRecognition = null; // { rawTranscript, normalizedTranscript, corrections, hadSelfCorrection, audioFile, inputSource }

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
      // В редактор отдаём нормализованный текст — он чище исходного.
      els.orderText.value = els.normalizedText.textContent || els.transcriptText.textContent;
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

  // Загружает стандартный заказ клиента по имени от GPT и подставляет телефон/имя.
  // Имя часто неполное («навруз» → «Ресторан Навруз»), поэтому ищем регистро-
  // независимо (ilike): сначала по всему имени, затем по каждому слову длиннее
  // 2 символов. Возвращает массив позиций стандартного заказа (клиент найден,
  // заказ может быть пустым) либо null (клиент в базе не найден).
  async function loadStandardOrder(name) {
    if (!name || !window.sb) return null;

    // Сначала — поиск по имени целиком.
    let { data } = await window.sb.from("clients")
      .select("name, phone, standard_order")
      .ilike("name", likeContains(name))
      .limit(1);

    // Не нашли — пробуем каждое слово отдельно (короткие слова игнорируем).
    if (!data || !data.length) {
      const words = name.split(/\s+/).filter(function (w) { return w.length > 2; });
      for (const word of words) {
        const res = await window.sb.from("clients")
          .select("name, phone, standard_order")
          .ilike("name", likeContains(word))
          .limit(1);
        if (res.data && res.data.length) { data = res.data; break; }
      }
    }

    if (!data || !data.length) return null;

    const client = data[0];
    // Автоподстановка: телефон (если поле пустое) и каноническое имя из базы —
    // по нему заказ свяжется с историей клиента.
    if (client.phone && !els.clientPhone.value.trim()) els.clientPhone.value = client.phone;
    els.clientName.value = client.name;
    return Array.isArray(client.standard_order) ? client.standard_order : [];
  }

  // Экранирует спецсимволы LIKE (% _ \) и оборачивает в %…% (поиск подстроки).
  function likeContains(fragment) {
    return "%" + String(fragment).replace(/([%_\\])/g, "\\$1") + "%";
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
      let rawText = "";
      let audioFile = null;
      const inputSource = mode;

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
        rawText = await window.AI.transcribeAudio(file);
        audioFile = file;
        if (!rawText.trim()) {
          els.transcriptText.textContent = rawText;
          els.transcriptBlock.classList.remove("hidden");
          showMsg(els.recognizeMsg, "warn", "Whisper вернул пустой текст. Проверьте запись.");
          return;
        }
      } else {
        rawText = els.orderText.value.trim();
        if (!rawText) { showMsg(els.recognizeMsg, "warn", "Введите текст заказа."); return; }
      }

      // Этап нормализации между Whisper и GPT: числительные → цифры, исправления,
      // обнаружение самоисправлений. На разбор и в source_text идёт нормализованный текст.
      const norm = window.Normalizer
        ? window.Normalizer.normalizeTranscript(rawText)
        : { raw: rawText, text: rawText, corrections: [], selfCorrections: [], hadSelfCorrection: false };

      renderTranscript(rawText, norm);
      sourceText = norm.text;
      lastRecognition = {
        rawTranscript: rawText,
        normalizedTranscript: norm.text,
        corrections: norm.corrections,
        hadSelfCorrection: norm.hadSelfCorrection,
        audioFile: audioFile,
        inputSource: inputSource
      };

      setBusy("Разбираю заказ (GPT-4o-mini)…");
      const parsed = await window.AI.parseOrder(norm.text);
      await applyParsed(parsed || {});

      if (!items.length) {
        showMsg(els.recognizeMsg, "warn", "Позиции не распознаны. Проверьте текст и попробуйте ещё раз.");
      } else {
        const review = items.filter(needsReview).length;
        showMsg(els.recognizeMsg, "success",
          "Распознано позиций: " + items.length +
          (review ? ". Жёлтым выделено то, что нужно проверить (" + review + ")." : "."));
      }
    } catch (e) {
      showMsg(els.recognizeMsg, "error", "Ошибка: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.recognizeBtn.disabled = false;
    }
  }

  // Показывает исходную и нормализованную расшифровку + список замен (ЗАДАЧА 4).
  function renderTranscript(rawText, norm) {
    els.transcriptText.textContent = rawText;
    els.normalizedText.textContent = norm.text || rawText;

    const changes = dedupeCorrections(norm.corrections);
    let html = "";
    if (changes.length) {
      html += '<div class="corr-line"><b>Замены:</b> ' +
        changes.slice(0, 10).map(function (c) {
          return esc(c.from) + " → " + esc(c.to);
        }).join(" · ") +
        (changes.length > 10 ? " …" : "") + "</div>";
    }
    if (norm.hadSelfCorrection) {
      html += '<div class="corr-line corr-warn">⚠ Обнаружено самоисправление клиента (' +
        esc(norm.selfCorrections.join(", ")) +
        ") — проверьте количества и товары.</div>";
    }
    els.correctionsList.innerHTML = html;
    els.correctionsList.classList.toggle("hidden", !html);

    els.transcriptBlock.classList.remove("hidden");
  }

  // Убирает повторы и пустые/тождественные замены, чтобы не засорять список.
  function dedupeCorrections(corrections) {
    const seen = {};
    const out = [];
    (corrections || []).forEach(function (c) {
      if (!c || c.from == null || c.to == null) return;
      const from = String(c.from).trim();
      const to = String(c.to).trim();
      if (!from || from.toLowerCase() === to.toLowerCase()) return;
      const key = from.toLowerCase() + "→" + to.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ from: from, to: to });
    });
    return out;
  }

  function setBusy(label) {
    els.recognizeBtn.disabled = true;
    showMsg(els.recognizeMsg, "info", '<span class="spinner"></span> ' + label);
  }

  async function applyParsed(parsed) {
    let newItems = (Array.isArray(parsed.items) ? parsed.items : []).map(normalizeItem);
    const flagsHtml = [];

    if (parsed.client_name && !els.clientName.value.trim()) {
      els.clientName.value = String(parsed.client_name);
    }

    // Нечёткий поиск клиента в базе + автоподстановка телефона и имени.
    // standardOrder: массив позиций (клиент найден) либо null (не найден).
    const standardOrder = await loadStandardOrder(els.clientName.value);
    const found = standardOrder !== null;
    const clientName = els.clientName.value.trim();

    if (parsed.urgent) {
      flagsHtml.push('<span class="badge badge-urgent">Срочный заказ</span>');
    }
    if (parsed.client_comment) {
      flagsHtml.push('<div class="client-sub">Комментарий клиента: ' + esc(parsed.client_comment) + "</div>");
    }

    // «Как обычно» — подставляем стандартный заказ клиента из базы.
    if (parsed.repeat_last_order) {
      if (found && standardOrder.length) {
        const stdItems = standardOrder.map(function (it) {
          return normalizeItem(Object.assign({}, it, { confidence: "high", note: "" }));
        });
        newItems = stdItems.concat(newItems);
        flagsHtml.push('<div class="msg msg-info">Клиент просит «как обычно» — подставлен стандартный заказ клиента «' +
          esc(clientName) + "».</div>");
      } else if (found) {
        flagsHtml.push('<div class="msg msg-warn">Клиент «' + esc(clientName) +
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
    const confidence = it.confidence === "low" || it.confidence === "medium" ? it.confidence : "high";
    const corrected = it.corrected === true;
    // confidence_score: берём от модели, иначе выводим из confidence/qty (обратная совместимость).
    let score = typeof it.confidence_score === "number" && isFinite(it.confidence_score)
      ? clamp(it.confidence_score, 0, 100)
      : deriveScore(confidence, qty, corrected);
    if (qty == null) score = Math.min(score, 50); // нет количества — позиция неполная
    if (corrected) score = Math.min(score, 70);   // было самоисправление — перепроверить
    return {
      name: it.name ? String(it.name) : "",
      qty: qty,
      unit: canonicalUnit(it.unit),
      price: price,
      confidence: confidence,
      confidence_score: Math.round(score),
      corrected: corrected,
      note: it.note ? String(it.note) : ""
    };
  }

  // Если модель не вернула confidence_score — оцениваем по старым полям.
  function deriveScore(confidence, qty, corrected) {
    let s = confidence === "low" ? 40 : confidence === "medium" ? 65 : 90;
    if (qty == null) s = Math.min(s, 45);
    if (corrected) s -= 15;
    return clamp(s, 5, 100);
  }

  // Приводит произнесённую единицу к каноничной системы (dona→шт, juft→пар …).
  function canonicalUnit(unit) {
    const raw = unit == null ? "" : String(unit).trim();
    if (!raw) return "шт";
    const map = (window.ZakazDictionary && window.ZakazDictionary.units) || {};
    const hit = map[raw.toLowerCase()];
    return hit || raw;
  }

  // Позиция требует проверки: нет количества, низкая уверенность или самоисправление.
  function needsReview(item) {
    return item.qty == null ||
      item.confidence === "low" ||
      item.corrected === true ||
      (typeof item.confidence_score === "number" && item.confidence_score < REVIEW_THRESHOLD);
  }

  // Текст причин для подсказки менеджеру.
  function reviewReasons(item) {
    const r = [];
    if (item.qty == null) r.push("нет количества");
    if (item.corrected === true) r.push("было самоисправление");
    if (item.confidence === "low" ||
        (typeof item.confidence_score === "number" && item.confidence_score < REVIEW_THRESHOLD)) {
      r.push("низкая уверенность");
    }
    return r.join(", ");
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, Number(n)));
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
    const confDiv = document.createElement("div");
    confDiv.className = "item-confidence";
    tdName.appendChild(nameInp);
    tdName.appendChild(noteDiv);
    tdName.appendChild(confDiv);

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
      // Менеджер подтвердил/поправил название — уточнения по нему сняты.
      item.confidence = "high";
      item.confidence_score = 100;
      item.corrected = false;
      item.note = "";
      noteDiv.textContent = "";
      refreshRowState();
    });
    qtyInp.addEventListener("input", function () {
      item.qty = qtyInp.value === "" ? null : Number(qtyInp.value);
      // Менеджер подтвердил количество — снимаем пометку самоисправления.
      if (item.qty != null) item.corrected = false;
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
      const warn = needsReview(item);
      tr.classList.toggle("row-warn", warn);
      if (warn) {
        const score = typeof item.confidence_score === "number" ? item.confidence_score : "";
        confDiv.textContent = "Проверьте" + (score !== "" ? " · уверенность " + score + "%" : "") +
          (reviewReasons(item) ? " (" + reviewReasons(item) + ")" : "");
        confDiv.classList.add("warn");
      } else {
        confDiv.textContent = "";
        confDiv.classList.remove("warn");
      }
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
      const { data, error } = await window.sb.from("orders").insert(payload).select("id").single();
      if (error) throw new Error(error.message);
      lastSavedSignature = signature;
      await upsertClient(order.client_name, order.client_phone);
      // Логирование для обучения — не должно влиять на результат сохранения.
      await logTraining(data && data.id, order);
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

  // ── Логирование для обучения (ЗАДАЧА 7) ──
  // Сохраняем аудио, исходную и нормализованную расшифровку и итоговый заказ
  // в таблицу order_logs. Всё best-effort: сбой логирования НЕ ломает сохранение
  // заказа и работает даже на ещё не мигрированной БД (таблица/бакет могут
  // отсутствовать — тогда просто пишем предупреждение в консоль).
  async function logTraining(orderId, order) {
    if (!window.sb) return;
    try {
      const rec = lastRecognition || {};
      let audioUrl = null;
      if (rec.audioFile) audioUrl = await uploadAudio(rec.audioFile);

      const payload = {
        order_id: orderId || null,
        client_name: order.client_name || null,
        source: rec.inputSource || (mode === "audio" ? "audio" : "text"),
        audio_url: audioUrl,
        transcript_raw: rec.rawTranscript || null,
        transcript_normalized: rec.normalizedTranscript || sourceText || null,
        corrections: Array.isArray(rec.corrections) ? rec.corrections : [],
        had_self_correction: !!rec.hadSelfCorrection,
        items: order.items
      };

      const { error } = await window.sb.from("order_logs").insert(payload);
      if (error) console.warn("[ZakazBot] Лог order_logs не записан:", error.message);
    } catch (e) {
      console.warn("[ZakazBot] Логирование не выполнено:", e && e.message ? e.message : e);
    }
  }

  // Загружает аудиофайл в бакет Storage и возвращает публичный URL (или null).
  async function uploadAudio(file) {
    try {
      const safe = String(file.name || "audio.ogg").replace(/[^\w.\-]+/g, "_");
      const path = new Date().toISOString().slice(0, 10) + "/" + Date.now() + "_" + safe;
      const up = await window.sb.storage.from(AUDIO_BUCKET).upload(path, file, {
        contentType: file.type || undefined,
        upsert: false
      });
      if (up.error) throw up.error;
      const pub = window.sb.storage.from(AUDIO_BUCKET).getPublicUrl(path);
      return pub && pub.data ? pub.data.publicUrl || null : null;
    } catch (e) {
      console.warn("[ZakazBot] Не удалось загрузить аудио:", e && e.message ? e.message : e);
      return null;
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
