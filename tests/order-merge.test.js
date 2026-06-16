// Тесты слияния стандартного заказа с изменениями (js/order-merge.js).
// Запуск: node tests/order-merge.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "js", "order-merge.js"), "utf8"),
  sandbox
);
const { mergeStandardOrder, namesMatch, matchProduct } = sandbox.window.OrderMerge;

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ " + label); }
}
function item(name, qty, unit) { return { name: name, qty: qty, unit: unit || "шт" }; }
function byName(items, frag) {
  return items.filter(function (i) { return namesMatch(i.name, frag); });
}

console.log("order-merge: mergeStandardOrder");

// 1. Совпадение по названию → обновление количества, без дубля.
let m = mergeStandardOrder([ item("Вилки пластиковые", 1000) ], [ item("вилки пластиковые", 200) ]);
check("обновление qty без дубля: 1 позиция", m.items.length === 1);
check("обновление qty без дубля: qty=200", m.items[0].qty === 200);
check("обновление qty без дубля: change updated", m.changes.some(function (c) { return c.type === "updated" && c.to === 200; }));

// 2. Другой порядок слов — то же совпадение.
m = mergeStandardOrder([ item("Вилки пластиковые", 1000) ], [ item("пластиковые вилки", 200) ]);
check("порядок слов не важен: 1 позиция, qty=200", m.items.length === 1 && m.items[0].qty === 200);

// 3. Уточнённое название («вилки» ↔ «вилки пластиковые»).
m = mergeStandardOrder([ item("Вилки пластиковые", 1000) ], [ item("вилки", 200) ]);
check("совпадение по подмножеству слов: 1 позиция", m.items.length === 1 && m.items[0].qty === 200);

// 4. Новый товар добавляется отдельной строкой.
m = mergeStandardOrder([ item("Салфетки", 10) ], [ item("Кружки", 4) ]);
check("новый товар добавлен: 2 позиции", m.items.length === 2);
check("новый товар: qty сохранён", byName(m.items, "кружки")[0].qty === 4);

// 5. qty=0 убирает позицию из заказа.
m = mergeStandardOrder([ item("Вилки", 1000), item("Салфетки", 10) ], [ item("вилки", 0) ]);
check("qty=0 убирает позицию: осталась 1", m.items.length === 1);
check("qty=0 убирает именно вилки", byName(m.items, "вилки").length === 0);
check("qty=0: change removed", m.changes.some(function (c) { return c.type === "removed"; }));

// 6. НЕТ ложного совпадения: «молоко» и «молоток» — разные товары.
m = mergeStandardOrder([ item("Молоко", 5) ], [ item("Молоток", 2) ]);
check("молоко ≠ молоток: 2 позиции", m.items.length === 2);

// 7. Неоднозначность: совпало несколько позиций — не угадываем, помечаем.
m = mergeStandardOrder(
  [ item("Масло сливочное", 1), item("Масло подсолнечное", 1) ],
  [ item("масло", 3) ]
);
check("неоднозначность: 3 позиции (обе базовые + новая)", m.items.length === 3);
check("неоднозначность: помечено ambiguous", m.changes.some(function (c) { return c.type === "ambiguous"; }));
check("неоднозначность: базовые не изменены", byName(m.items, "масло сливочное")[0].qty === 1);

// 8. Пример из ТЗ: «четыре кружки» + «вместо тысячи вилок — двести».
m = mergeStandardOrder(
  [ item("Вилки пластиковые", 1000), item("Кружки", 2) ],
  [ item("кружки", 4), item("вилки пластиковые", 200) ]
);
check("пример ТЗ: 2 позиции (без дублей)", m.items.length === 2);
check("пример ТЗ: вилки 200", byName(m.items, "вилки пластиковые")[0].qty === 200);
check("пример ТЗ: кружки 4", byName(m.items, "кружки")[0].qty === 4);

// 9. Регистр и «ё» не мешают совпадению.
m = mergeStandardOrder([ item("Тёрки", 3) ], [ item("терки", 7) ]);
check("ё/регистр: обновление, 1 позиция", m.items.length === 1 && m.items[0].qty === 7);

// 10. Повторное упоминание того же товара с тем же qty — без дубля.
m = mergeStandardOrder([ item("Стаканы", 50) ], [ item("стаканы", 50) ]);
check("повтор без изменений: 1 позиция, без дубля", m.items.length === 1);

// 11. Удаление несуществующего товара — игнорируется, без пустых строк.
m = mergeStandardOrder([ item("Салфетки", 10) ], [ item("вилки", 0) ]);
check("удаление несуществующего игнорируется: 1 позиция", m.items.length === 1);

// 13. Словоформы: «Стакан пластик» (станд.) ↔ «пластиковый стакан» — одна строка.
m = mergeStandardOrder([ item("Стакан пластик", 150) ], [ item("пластиковый стакан", 200) ]);
check("словоформы стакан: 1 позиция, qty=200", m.items.length === 1 && m.items[0].qty === 200);

// 14. Сценарий из чата: «как обычно» + позднее количество для стаканов, без дублей.
m = mergeStandardOrder(
  [ item("Стакан пластик", 150), item("пластик ложка", 100) ],
  [ item("пластиковые стаканы", null), item("пластиковый стакан", 200), item("пластиковая ложка", 100) ]
);
check("позднее кол-во стаканов → 2 позиции (без дублей)", m.items.length === 2);
check("стакан обновлён до 200", byName(m.items, "стакан")[0].qty === 200);

// ── matchProduct: подстановка цены из каталога ──
console.log("order-merge: matchProduct");
var catalog = [
  { name: "Вилки пластиковые", unit: "уп", price: 12000 },
  { name: "Стаканы 200мл", unit: "уп", price: 8000 },
  { name: "Салфетки бумажные", unit: "уп", price: 5000 }
];
check("однозначное совпадение → товар", (matchProduct("вилки пластиковые", catalog) || {}).price === 12000);
check("уточнение слов («вилки») → товар", (matchProduct("вилки", catalog) || {}).price === 12000);
check("нет совпадения → null", matchProduct("перчатки", catalog) === null);

// Неоднозначность: два товара содержат «вилки» — цену не подставляем.
var catalog2 = [
  { name: "Вилки пластиковые", price: 12000 },
  { name: "Вилки деревянные", price: 15000 }
];
check("неоднозначно (две «вилки») → null", matchProduct("вилки", catalog2) === null);
check("уточнённое «вилки деревянные» → конкретный товар",
  (matchProduct("вилки деревянные", catalog2) || {}).price === 15000);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
