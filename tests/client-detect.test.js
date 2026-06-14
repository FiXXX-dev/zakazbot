// Тесты логики определения клиента (js/client-detect.js → pickClient).
// Запуск: node tests/client-detect.test.js
//
// Тестируется чистая функция выбора клиента из нескольких имён с учётом:
// базы клиентов (inDb), приветствий (greeting) и списка сотрудников (managers).

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "js", "client-detect.js"), "utf8"),
  sandbox
);
const { pickClient } = sandbox.window.ClientDetect;

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log("  ✓ " + label); }
  else {
    failed++;
    console.log("  ✗ " + label + "\n      ожидалось: " + JSON.stringify(expected) +
      "\n      получено:  " + JSON.stringify(actual));
  }
}
const name = function (res) { return res.chosen ? res.chosen.name : null; };

console.log("client-detect: pickClient");

// 1. Пример из ТЗ: оба после приветствия; Миша — в базе, Сулуддин — сотрудник.
//    Ожидается клиент «Миша».
let r = pickClient(
  [ { name: "Сулуддин", greeting: true, inDb: false },
    { name: "Миша",     greeting: true, inDb: true } ],
  ["Сулуддин"]
);
check("пример из ТЗ → Миша", name(r), "Миша");
check("пример из ТЗ → reason single-db-match", r.reason, "single-db-match");

// 2. Несколько имён, только одно в базе → выбрать его (правило 4),
//    даже без списка сотрудников.
check("одно имя в базе → оно",
  name(pickClient(
    [ { name: "Сулуддин", greeting: true, inDb: false },
      { name: "Миша",     greeting: true, inDb: true } ],
    []
  )), "Миша");

// 3. Сотрудник исключается, даже если стоит первым (правило 6).
check("сотрудник исключён → второй кандидат",
  name(pickClient(
    [ { name: "Сулуддин", greeting: true,  inDb: false },
      { name: "Миша",     greeting: false, inDb: false } ],
    ["сулуддин"]
  )), "Миша");

// 4. Имя сразу после приветствия не выбирается автоматически (правило 5):
//    предпочитаем не-приветственное имя, даже если приветственное — первое.
check("приветственное не выбирается автоматически → не-приветственное",
  name(pickClient(
    [ { name: "Сулуддин", greeting: true,  inDb: false },
      { name: "Миша",     greeting: false, inDb: false } ],
    []
  )), "Миша");

// 5. Наличие в базе важнее, чем отсутствие приветствия (правило 3 — высокий приоритет базы).
r = pickClient(
  [ { name: "Андрей", greeting: false, inDb: false },
    { name: "Навруз", greeting: true,  inDb: true } ],
  []
);
check("в базе важнее не-приветствия → Навруз", name(r), "Навруз");

// 6. Одно имя, есть в базе → оно.
check("одно имя в базе",
  name(pickClient([ { name: "Навруз", greeting: false, inDb: true } ], [])), "Навруз");

// 7. Все имена приветственные и никого нет в базе → последнее
//    (первым обычно приветствуют менеджера).
check("все приветствия, базы нет → последнее",
  name(pickClient(
    [ { name: "Сулуддин", greeting: true, inDb: false },
      { name: "Миша",     greeting: true, inDb: false } ],
    []
  )), "Миша");

// 8. Остались только сотрудники → клиент не определён (null).
r = pickClient([ { name: "Сулуддин", greeting: true, inDb: false } ], ["сулуддин"]);
check("только сотрудник → null", name(r), null);
check("только сотрудник → reason no-eligible", r.reason, "no-eligible");

// 9. Обратная совместимость: модель вернула только одно имя (client_name),
//    name_candidates нет → используется это имя.
check("единственный кандидат (старый формат)",
  name(pickClient([ { name: "Миша", greeting: false, inDb: false } ], [])), "Миша");

// 10. Несколько в базе → среди них предпочитаем не-приветственное.
check("несколько в базе → не-приветственное",
  name(pickClient(
    [ { name: "Навруз", greeting: true,  inDb: true },
      { name: "Бахор",  greeting: false, inDb: true } ],
    []
  )), "Бахор");

// 11. Пустой список кандидатов → null без ошибок.
check("пустой список → null", name(pickClient([], [])), null);

// 12. Сотрудник есть в базе по ошибке, но всё равно исключается; клиент — другой.
check("сотрудник в базе всё равно исключён",
  name(pickClient(
    [ { name: "Сулуддин", greeting: true,  inDb: true },
      { name: "Миша",     greeting: false, inDb: true } ],
    ["сулуддин"]
  )), "Миша");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
