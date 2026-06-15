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
    cMsg: document.getElementById("clients-msg")
  };

  let userId = null;

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

  // Файл (.xlsx/.csv) → массив объектов-строк, ключи — заголовки первой строки.
  async function readRows(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { defval: "" });
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
      const raw = await readRows(file);
      if (!raw.length) { show(els.pMsg, "warn", "В файле нет строк."); return; }

      let skipped = 0;
      const rows = [];
      raw.forEach(function (r) {
        const name = str(pick(r, ["Наименование", "Название", "Товар", "name"]));
        if (!name) { skipped++; return; }
        rows.push({
          name: name,
          unit: str(pick(r, ["Единица", "Ед.изм.", "Единица измерения", "unit"])) || null,
          price: parsePrice(pick(r, ["Цена", "price"])),
          user_id: userId
        });
      });

      if (!rows.length) {
        show(els.pMsg, "error",
          "Не найдено ни одного товара. Проверьте, что в первой строке есть колонка «Наименование».");
        return;
      }

      show(els.pMsg, "info", '<span class="spinner"></span> Загружаю товаров: ' + rows.length + "…");
      const added = await insertChunked("products", rows);
      show(els.pMsg, "success", "Добавлено товаров: " + added +
        (skipped ? ". Пропущено строк без названия: " + skipped : "") + ".");
      els.pFile.value = "";
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
