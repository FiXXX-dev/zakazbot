// Выгрузка заказа в Excel через SheetJS (глобальный XLSX с CDN).
// Колонки: № | Наименование | Количество | Ед.изм. | Цена | Сумма
// Имя файла: Заказ_[клиент]_[дата].xlsx

(function () {
  function sanitizeForFile(s) {
    const cleaned = String(s || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "_");
    return cleaned || "Без_имени";
  }

  function fileName(clientName) {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, "0"); };
    const date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return "Заказ_" + sanitizeForFile(clientName) + "_" + date + ".xlsx";
  }

  // order: { client_name, items: [{ name, qty, unit, price }] }
  function downloadOrderExcel(order) {
    if (typeof XLSX === "undefined") {
      alert("Библиотека SheetJS не загрузилась. Проверьте подключение к интернету.");
      return;
    }

    const items = Array.isArray(order.items) ? order.items : [];
    const rows = [["№", "Код", "Наименование", "Количество", "Ед.изм.", "Цена", "Сумма"]];
    let total = 0;

    items.forEach(function (it, i) {
      const qty = it.qty == null || it.qty === "" ? null : Number(it.qty);
      const price = it.price == null || it.price === "" ? null : Number(it.price);
      const sum = qty != null && price != null ? qty * price : null;
      if (sum != null) total += sum;
      rows.push([
        i + 1,
        it.article || "",
        it.name || "",
        qty == null ? "" : qty,
        it.unit || "",
        price == null ? "" : price,
        sum == null ? "" : sum
      ]);
    });

    rows.push(["", "", "Итого", "", "", "", total]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 5 },  // №
      { wch: 10 }, // Код
      { wch: 38 }, // Наименование
      { wch: 12 }, // Количество
      { wch: 9 },  // Ед.изм.
      { wch: 12 }, // Цена
      { wch: 14 }  // Сумма
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Заказ");
    XLSX.writeFile(wb, fileName(order.client_name));
  }

  window.ExcelUtils = {
    downloadOrderExcel: downloadOrderExcel,
    fileName: fileName
  };
})();
