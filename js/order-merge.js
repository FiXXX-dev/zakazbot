// Слияние стандартного заказа клиента с услышанными изменениями.
//
// GPT не видит стандартный заказ (он в базе), поэтому дедуп и применение
// изменений делаются здесь, на фронтенде, когда обе части уже известны:
//   base   — стандартный заказ клиента из базы;
//   spoken — позиции, распознанные из голосового заказа.
//
// Правила:
//   • позиция из spoken, совпавшая с позицией base по названию, ОБНОВЛЯЕТ её
//     (количество/единицу), а не добавляет дубль;
//   • spoken с qty=0 (или remove=true) — УБИРАЕТ позицию из заказа;
//   • совпадение по названию консервативное: множество слов одного названия —
//     подмножество слов другого (учитывает порядок слов и уточнения, например
//     «вилки» ↔ «вилки пластиковые»), без рискованных совпадений по префиксу
//     («молоко» и «молоток» НЕ совпадают);
//   • если spoken совпал с НЕСКОЛЬКИМИ позициями base — не угадываем, добавляем
//     как новую с пометкой «возможно дубль».
//
// Чистая логика (без DOM) — покрыта тестами tests/order-merge.test.js.

(function () {
  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Лёгкий стемминг: обрезаем частые русские окончания, чтобы «стакан/стаканы/
  // стаканов» и «пластиковый/пластик» считались одним словом. Основа ≥ 4 символов.
  function stem(w) {
    if (w.length <= 4) return w;
    const ends = [
      "овский", "овская", "овские", "ового", "овому", "овыми", "овых",
      "овый", "овая", "овое", "овые", "овой", "овым", "ами", "ями",
      "ах", "ях", "ев", "ов", "ей", "ой", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ом", "ем",
      "а", "е", "и", "о", "у", "ы", "ь", "я", "ю"
    ];
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      if (w.length - e.length >= 4 && w.slice(-e.length) === e) return w.slice(0, w.length - e.length);
    }
    return w;
  }

  function wordSet(s) {
    const set = new Set();
    norm(s).split(" ").forEach(function (w) { if (w.length >= 2) set.add(stem(w)); });
    return set;
  }

  // Консервативное совпадение названий: слова меньшего множества ⊆ большего.
  function namesMatch(a, b) {
    const A = wordSet(a), B = wordSet(b);
    if (!A.size || !B.size) return false;
    const small = A.size <= B.size ? A : B;
    const big = A.size <= B.size ? B : A;
    for (const w of small) { if (!big.has(w)) return false; }
    return true;
  }

  function isRemoval(it) {
    return !!it && (it.remove === true || it.qty === 0);
  }

  function fmtQty(q) { return q == null ? "?" : String(q); }

  // base, spoken — массивы позиций { name, qty, unit, price, … }.
  // → { items: [...], changes: [{ type:'updated'|'removed'|'added'|'ambiguous', name, from?, to? }] }
  function mergeStandardOrder(base, spoken) {
    const result = (base || []).map(function (b) { return Object.assign({}, b); });
    const removed = new Array(result.length).fill(false);
    const changes = [];
    const added = [];

    (spoken || []).forEach(function (sp) {
      const matches = [];
      result.forEach(function (b, i) {
        if (!removed[i] && namesMatch(b.name, sp.name)) matches.push(i);
      });

      if (matches.length === 1) {
        const i = matches[0];
        if (isRemoval(sp)) {
          removed[i] = true;
          changes.push({ type: "removed", name: result[i].name });
        } else {
          const beforeQty = result[i].qty;
          const beforeUnit = result[i].unit;
          let changed = false;
          if (sp.qty != null && sp.qty !== beforeQty) { result[i].qty = sp.qty; changed = true; }
          if (sp.unit && sp.unit !== beforeUnit) { result[i].unit = sp.unit; }
          if (sp.price != null) { result[i].price = sp.price; }
          if (changed) {
            result[i].note = "обновлено: было " + fmtQty(beforeQty) + (beforeUnit ? " " + beforeUnit : "");
            changes.push({ type: "updated", name: result[i].name, from: beforeQty, to: result[i].qty });
          }
          // Совпавшую позицию НЕ дублируем (даже если ничего не изменилось).
        }
      } else if (matches.length === 0) {
        if (!isRemoval(sp)) {
          added.push(sp);
          changes.push({ type: "added", name: sp.name });
        }
        // Удаление несуществующей позиции — просто игнорируем.
      } else {
        // Неоднозначно: совпало несколько позиций — не угадываем.
        const copy = Object.assign({}, sp);
        copy.note = (copy.note ? copy.note + " · " : "") + "возможно дубль — проверьте";
        added.push(copy);
        changes.push({ type: "ambiguous", name: sp.name });
      }
    });

    const items = [];
    result.forEach(function (b, i) { if (!removed[i]) items.push(b); });
    return { items: items.concat(added), changes: changes };
  }

  // Ищет товар в каталоге (products) по названию позиции. Возвращает запись
  // ТОЛЬКО при однозначном совпадении (ровно один товар) — иначе null, чтобы
  // не подставить чужую цену. Совпадение — то же консервативное namesMatch.
  function matchProduct(name, products) {
    const hits = (products || []).filter(function (p) {
      return p && p.name && namesMatch(name, p.name);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  window.OrderMerge = {
    mergeStandardOrder: mergeStandardOrder,
    namesMatch: namesMatch,
    matchProduct: matchProduct
  };
})();
