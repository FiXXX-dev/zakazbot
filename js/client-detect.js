// Определение клиента из нескольких имён в голосовом заказе.
//
// Чистая логика выбора (без DOM и без сети), чтобы её можно было покрыть
// тестами: tests/client-detect.test.js. Сетевую часть (поиск в базе клиентов)
// и подстановку имени/телефона делает js/new-order.js.
//
// Приоритеты выбора (см. требования):
//   1. Имена сотрудников компании (managerNames) — НЕ клиенты, исключаются.
//   2. Имя, найденное в базе клиентов (inDb=true) — высокий приоритет.
//   3. Среди равных предпочитаем НЕ приветственное обращение (greeting=false):
//      «Добрый день, X» — это обращение (часто к менеджеру), а не клиент.
//   4. Если в базе никого нет — первое не-приветственное имя; если все
//      приветственные — последнее (первым обычно приветствуют менеджера).

(function () {
  function norm(s) {
    return String(s == null ? "" : s).trim().toLowerCase();
  }

  function managerSet(names) {
    const set = new Set();
    (names || []).forEach(function (n) { set.add(norm(n)); });
    return set;
  }

  // candidates: [{ name, greeting:boolean, inDb:boolean }]
  // managers: массив имён сотрудников или готовый Set.
  // → { chosen: {name,greeting,inDb} | null, reason: string, eligible: [...] }
  function pickClient(candidates, managers) {
    const mset = managers instanceof Set ? managers : managerSet(managers);

    const list = (candidates || [])
      .filter(function (c) { return c && c.name != null && String(c.name).trim() !== ""; })
      .map(function (c) {
        return { name: String(c.name).trim(), greeting: c.greeting === true, inDb: c.inDb === true };
      });

    // 1. Убираем сотрудников — они не клиенты.
    const eligible = list.filter(function (c) { return !mset.has(norm(c.name)); });
    if (!eligible.length) return { chosen: null, reason: "no-eligible", eligible: eligible };

    // 2. Приоритет — найденные в базе.
    const inDb = eligible.filter(function (c) { return c.inDb; });
    if (inDb.length) {
      const chosen = firstNonGreeting(inDb) || inDb[0];
      return {
        chosen: chosen,
        reason: inDb.length === 1 ? "single-db-match" : "db-match",
        eligible: eligible
      };
    }

    // 3. В базе никого нет: не-приветственное имя, иначе последнее приветственное.
    const nonGreeting = firstNonGreeting(eligible);
    if (nonGreeting) return { chosen: nonGreeting, reason: "non-greeting", eligible: eligible };
    return { chosen: eligible[eligible.length - 1], reason: "fallback-greeting", eligible: eligible };
  }

  function firstNonGreeting(list) {
    for (let i = 0; i < list.length; i++) {
      if (!list[i].greeting) return list[i];
    }
    return null;
  }

  window.ClientDetect = {
    pickClient: pickClient,
    managerSet: managerSet
  };
})();
