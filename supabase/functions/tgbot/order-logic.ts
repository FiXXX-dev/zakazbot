// Чистая логика для бота — порт client-detect.js + order-merge.js.
// Должна совпадать с фронтендом; менять синхронно.
// deno-lint-ignore-file no-explicit-any

export const MANAGER_NAMES = ["сулуддин", "сулиддин", "салохиддин", "салоҳиддин", "suluddin", "salohiddin"];

function norm(s: any): string {
  return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
// Лёгкий стемминг: «стакан/стаканы/стаканов», «пластиковый/пластик» → одна основа.
function stem(w: string): string {
  if (w.length <= 4) return w;
  const ends = [
    "овский", "овская", "овские", "ового", "овому", "овыми", "овых",
    "овый", "овая", "овое", "овые", "овой", "овым", "ами", "ями",
    "ах", "ях", "ев", "ов", "ей", "ой", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ом", "ем",
    "а", "е", "и", "о", "у", "ы", "ь", "я", "ю",
  ];
  for (const e of ends) {
    if (w.length - e.length >= 4 && w.slice(-e.length) === e) return w.slice(0, w.length - e.length);
  }
  return w;
}

function wordSet(s: any): Set<string> {
  const set = new Set<string>();
  norm(s).split(" ").forEach((w) => { if (w.length >= 2) set.add(stem(w)); });
  return set;
}

// Консервативное совпадение названий: слова меньшего множества ⊆ большего.
export function namesMatch(a: any, b: any): boolean {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return false;
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  for (const w of s) { if (!l.has(w)) return false; }
  return true;
}

// candidates: [{name, greeting, inDb}] → выбранный или null.
export function pickClient(candidates: any[], managers: string[]): any {
  const mset = new Set((managers || []).map((n) => String(n).toLowerCase()));
  const list = (candidates || []).filter((c) => c && c.name)
    .map((c) => ({ name: String(c.name).trim(), greeting: c.greeting === true, inDb: c.inDb === true }));
  const eligible = list.filter((c) => !mset.has(c.name.toLowerCase()));
  if (!eligible.length) return null;
  const inDb = eligible.filter((c) => c.inDb);
  if (inDb.length) return inDb.find((c) => !c.greeting) || inDb[0];
  return eligible.find((c) => !c.greeting) || eligible[eligible.length - 1];
}

function isRemoval(it: any): boolean { return !!it && (it.remove === true || it.qty === 0); }

// Слияние стандартного заказа (base) с услышанными изменениями (spoken).
export function mergeStandardOrder(base: any[], spoken: any[]): { items: any[]; changes: any[] } {
  const result = (base || []).map((b) => Object.assign({}, b));
  const removed = new Array(result.length).fill(false);
  const changes: any[] = [];
  const added: any[] = [];
  (spoken || []).forEach((sp) => {
    const matches: number[] = [];
    result.forEach((b, i) => { if (!removed[i] && namesMatch(b.name, sp.name)) matches.push(i); });
    if (matches.length === 1) {
      const i = matches[0];
      if (isRemoval(sp)) { removed[i] = true; changes.push({ type: "removed", name: result[i].name }); }
      else {
        const beforeQty = result[i].qty, beforeUnit = result[i].unit;
        let changed = false;
        if (sp.qty != null && sp.qty !== beforeQty) { result[i].qty = sp.qty; changed = true; }
        if (sp.unit && sp.unit !== beforeUnit) { result[i].unit = sp.unit; }
        if (sp.price != null) { result[i].price = sp.price; }
        if (changed) changes.push({ type: "updated", name: result[i].name, from: beforeQty, to: result[i].qty });
      }
    } else if (matches.length === 0) {
      if (!isRemoval(sp)) { added.push(sp); changes.push({ type: "added", name: sp.name }); }
    } else { added.push(sp); changes.push({ type: "ambiguous", name: sp.name }); }
  });
  const items: any[] = [];
  result.forEach((b, i) => { if (!removed[i]) items.push(b); });
  return { items: items.concat(added), changes };
}

// Однозначное совпадение товара в каталоге. Если передан article — ищем по нему
// точно; иначе — по названию (namesMatch). Иначе null — чужую цену не ставим.
export function matchProduct(name: any, products: any[], article?: string): any {
  if (article) {
    const byArt = (products || []).filter((p) => p && p.article && String(p.article) === String(article));
    if (byArt.length === 1) return byArt[0];
  }
  const hits = (products || []).filter((p) => p && p.name && namesMatch(name, p.name));
  return hits.length === 1 ? hits[0] : null;
}
