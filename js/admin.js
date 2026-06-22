// Страница «Админ» (admin.html): импорт товаров и клиентов из .csv/.xlsx.
// Файлы читаются через SheetJS (глобальный XLSX с CDN), записываются в Supabase
// (таблицы products / clients) пакетами через window.sb.from(...).insert(...).

(function () {
  const els = {
    setup: document.getElementById("setup-warning"),
    pFile: document.getElementById("products-file"),
    pBtn: document.getElementById("products-btn"),
    pMsg: document.getElementById("products-msg"),
    cFile: document.getElementById("clients-file"),
    cBtn: document.getElementById("clients-btn"),
    cMsg: document.getElementById("clients-msg"),
    pSearch: document.getElementById("products-search"),
    pList: document.getElementById("products-list"),
    pClear: document.getElementById("products-clear")
  };

  let userId = null;
  let products = [];

  boot();

  function boot() {
    if (!window.sb) {
      els.setup.innerHTML =
        '<div class="msg msg-warn">Supabase не настроен: скопируйте <code>config.example.js</code> в <code>config.js</code> и заполните ключи. Импорт недоступен.</div>';
      els.pBtn.disabled = true;
      els.cBtn.disabled = true;
      return;
    }
    window.Auth.guard().then(function (user) {
      if (!user) return;
      userId = user.id;
      init();
    });
  }

  function init() {
    // Просмотр/удаление товаров не требует SheetJS — подключаем до проверки.
    els.pSearch.addEventListener("input", renderProducts);
    els.pClear.addEventListener("click", clearAllProducts);
    loadProducts();

    if (typeof XLSX === "undefined") {
      els.setup.innerHTML =
        '<div class="msg msg-error">Библиотека SheetJS не загрузилась (проверьте доступ к CDN). Чтение файлов недоступно.</div>';
      els.pBtn.disabled = true;
      els.cBtn.disabled = true;
      return;
    }
    els.pBtn.addEventListener("click", importProducts);
    els.cBtn.addEventListener("click", importClients);
  }

  // ── Просмотр и удаление товаров (таблица products, RLS по user_id) ──

  async function loadProducts() {
    els.pList.innerHTML = '<div class="msg msg-info"><span class="spinner"></span> Загрузка товаров…</div>';
    const { data, error } = await window.sb
      .from("products").select("*").eq("user_id", userId).order("name", { ascending: true });
    if (error) {
      els.pList.innerHTML = '<div class="msg msg-error">Не удалось загрузить товары: ' + esc(error.message) + "</div>";
      return;
    }
    products = data || [];
    renderProducts();
  }

  function renderProducts() {
    const q = (els.pSearch.value || "").trim().toLowerCase();
    els.pClear.style.display = products.length ? "" : "none";
    if (!products.length) {
      els.pList.innerHTML = '<div class="msg msg-info">Товаров пока нет. Загрузите файл выше.</div>';
      return;
    }
    const list = products.filter(function (p) {
      return !q || String(p.name || "").toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) {
      els.pList.innerHTML = '<div class="msg msg-info">Ничего не найдено по запросу «' + esc(q) + "».</div>";
      return;
    }
    const head = '<div class="client-sub" style="margin-bottom:6px">Всего товаров: ' + products.length +
      (q ? " · показано: " + list.length : "") + "</div>";
    const rows = list.map(function (p) {
      return "<tr>" +
        "<td>" + esc(p.article || "") + "</td>" +
        "<td>" + esc(p.name) + "</td>" +
        "<td>" + esc(p.unit || "") + "</td>" +
        "<td>" + (p.price == null ? "" : esc(fmtPrice(p.price))) + "</td>" +
        '<td><button type="button" class="row-del del-prod" data-id="' + esc(p.id) + '" title="Удалить">×</button></td>' +
        "</tr>";
    }).join("");
    els.pList.innerHTML = head +
      '<div class="table-wrap"><table class="items-table"><thead><tr>' +
        "<th>Код</th><th>Наименование</th><th>Ед.изм.</th><th>Цена</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";

    els.pList.querySelectorAll(".del-prod").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteProduct(btn.dataset.id); });
    });
  }

  async function deleteProduct(id) {
    const p = products.find(function (x) { return String(x.id) === String(id); });
    if (!confirm('Удалить товар «' + (p ? p.name : "") + '»?')) return;
    const { error } = await window.sb.from("products").delete().eq("id", id);
    if (error) { alert("Не удалось удалить: " + error.message); return; }
    products = products.filter(function (x) { return String(x.id) !== String(id); });
    renderProducts();
  }

  async function clearAllProducts() {
    if (!confirm("Удалить ВСЕ товары (" + products.length + ")? Действие необратимо.")) return;
    els.pClear.disabled = true;
    const { error } = await window.sb.from("products").delete().eq("user_id", userId);
    els.pClear.disabled = false;
    if (error) { alert("Не удалось удалить: " + error.message); return; }
    products = [];
    renderProducts();
  }

  function fmtPrice(n) {
    const v = Number(n);
    return isFinite(v) ? v.toLocaleString("ru-RU") : String(n);
  }

  // Читает лист из файла и определяет формат (1С или стандартный).
  // Возвращает { is1C: bool, rows: [...] } где rows — нормализованные объекты.
  async function readAndDetect(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { is1C: false, rows: [] };

    // Сырые строки как массив массивов — нужны для поиска шапки 1С.
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    // Ищем строку с ячейкой «Код» среди первых 20 строк (1С-формат).
    for (let r = 0; r < Math.min(raw.length, 20); r++) {
      const row = raw[r];
      const headers = row.map(function (v) { return String(v || "").trim().toLowerCase(); });
      const kodCol = headers.indexOf("код");
      if (kodCol < 0) continue;

      const naimCol = headers.findIndex(function (h) { return h === "наименование" || h.startsWith("наим"); });
      // «Продажная цена» — столбец с единицей; следующий за ним — цена.
      const priceUnitCol = headers.findIndex(function (h) { return h.includes("продажн"); });
      if (naimCol < 0 || priceUnitCol < 0) continue;

      const priceCol = priceUnitCol + 1;
      const rows1C = [];
      for (let dr = r + 1; dr < raw.length; dr++) {
        const drow = raw[dr];
        const name = str(drow[naimCol]);
        if (!name) continue;
        // Пропускаем подзаголовки (название совпадает с заголовком колонки).
        const nameLow = name.trim().toLowerCase();
        if (nameLow === "наименование" || nameLow === "наим.") continue;
        const article = str(drow[kodCol]) || null;
        const unit = str(drow[priceUnitCol]) || null;
        const price = parsePrice(drow[priceCol]);
        rows1C.push({ name: name, article: article, unit: unit, price: price });
      }
      return { is1C: true, rows: rows1C };
    }

    // Стандартный формат — SheetJS определяет заголовки из первой строки.
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    return { is1C: false, rows: rows };
  }

  // Значение строки по одному из возможных заголовков (без учёта регистра/пробелов).
  function pick(row, candidates) {
    const keys = Object.keys(row);
    for (let i = 0; i < candidates.length; i++) {
      const want = candidates[i].trim().toLowerCase();
      for (let j = 0; j < keys.length; j++) {
        if (keys[j].trim().toLowerCase() === want) return row[keys[j]];
      }
    }
    return undefined;
  }

  function str(v) {
    return v == null ? "" : String(v).trim();
  }

  function parsePrice(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    // «1 200,50» → 1200.50
    const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : null;
  }

  // Пакетная вставка (Supabase ограничивает размер запроса).
  async function insertChunked(table, rows) {
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const { error } = await window.sb.from(table).insert(batch);
      if (error) {
        throw new Error(error.message + " (успешно вставлено до ошибки: " + inserted + ")");
      }
      inserted += batch.length;
    }
    return inserted;
  }

  async function importProducts() {
    const file = els.pFile.files[0];
    if (!file) { show(els.pMsg, "warn", "Выберите файл (.csv или .xlsx)."); return; }

    els.pBtn.disabled = true;
    show(els.pMsg, "info", '<span class="spinner"></span> Читаю файл…');
    try {
      const detected = await readAndDetect(file);
      if (!detected.rows.length) { show(els.pMsg, "warn", "В файле нет строк."); return; }

      let skipped = 0;
      const rows = [];

      if (detected.is1C) {
        detected.rows.forEach(function (r) {
          rows.push({
            name: r.name,
            article: r.article,
            unit: r.unit,
            price: r.price,
            user_id: userId
          });
        });
      } else {
        detected.rows.forEach(function (r) {
          const name = str(pick(r, ["Наименование", "Название", "Товар", "name"]));
          if (!name) { skipped++; return; }
          rows.push({
            name: name,
            article: str(pick(r, ["Код", "Артикул", "article"])) || null,
            unit: str(pick(r, ["Единица", "Ед.изм.", "Единица измерения", "unit"])) || null,
            price: parsePrice(pick(r, ["Цена", "price"])),
            user_id: userId
          });
        });
      }

      if (!rows.length) {
        show(els.pMsg, "error",
          "Не найдено ни одного товара. Проверьте, что есть колонка «Наименование» (или «Код» для формата 1С).");
        return;
      }

      const fmtLabel = detected.is1C ? " (формат 1С)" : "";
      show(els.pMsg, "info", '<span class="spinner"></span> Загружаю товаров: ' + rows.length + fmtLabel + "…");
      const added = await insertChunked("products", rows);
      show(els.pMsg, "success", "Добавлено товаров: " + added + fmtLabel +
        (skipped ? ". Пропущено строк без названия: " + skipped : "") + ".");
      els.pFile.value = "";
      loadProducts();
    } catch (e) {
      show(els.pMsg, "error", "Ошибка: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.pBtn.disabled = false;
    }
  }

  async function importClients() {
    const file = els.cFile.files[0];
    if (!file) { show(els.cMsg, "warn", "Выберите файл (.csv или .xlsx)."); return; }

    els.cBtn.disabled = true;
    show(els.cMsg, "info", '<span class="spinner"></span> Читаю файл…');
    try {
      const raw = await readRows(file);
      if (!raw.length) { show(els.cMsg, "warn", "В файле нет строк."); return; }

      // Существующие имена — чтобы не плодить дубли при повторном импорте.
      const existing = new Set();
      const { data: cur, error: curErr } = await window.sb.from("clients").select("name").eq("user_id", userId);
      if (curErr) throw new Error(curErr.message);
      (cur || []).forEach(function (c) { existing.add(str(c.name).toLowerCase()); });

      let skippedEmpty = 0;
      let skippedDup = 0;
      const seen = new Set();
      const rows = [];
      raw.forEach(function (r) {
        const name = str(pick(r, ["Имя", "Название", "Клиент", "name"]));
        if (!name) { skippedEmpty++; return; }
        const key = name.toLowerCase();
        if (existing.has(key) || seen.has(key)) { skippedDup++; return; }
        seen.add(key);
        rows.push({
          name: name,
          phone: str(pick(r, ["Телефон", "Тел", "phone"])) || null,
          user_id: userId
        });
      });

      if (!rows.length) {
        const parts = [];
        if (skippedDup) parts.push("уже существуют: " + skippedDup);
        if (skippedEmpty) parts.push("без имени: " + skippedEmpty);
        show(els.cMsg, "warn", "Новых клиентов нет" + (parts.length ? " (" + parts.join(", ") + ")" : "") + ".");
        return;
      }

      show(els.cMsg, "info", '<span class="spinner"></span> Загружаю клиентов: ' + rows.length + "…");
      const added = await insertChunked("clients", rows);
      const extra = [];
      if (skippedDup) extra.push("пропущено уже существующих: " + skippedDup);
      if (skippedEmpty) extra.push("без имени: " + skippedEmpty);
      show(els.cMsg, "success", "Добавлено клиентов: " + added +
        (extra.length ? " (" + extra.join(", ") + ")" : "") + ".");
      els.cFile.value = "";
    } catch (e) {
      show(els.cMsg, "error", "Ошибка: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.cBtn.disabled = false;
    }
  }

  function show(el, type, html) {
    el.innerHTML = '<div class="msg msg-' + type + '">' + html + "</div>";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
