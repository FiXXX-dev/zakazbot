// Нормализация транскрипции для Telegram-бота (Deno) — порт js/dictionary.js +
// js/normalize.js. Логика должна совпадать с фронтендом; при правке словаря
// синхронизируйте с js/dictionary.js.

// deno-lint-ignore no-explicit-any
const D: any = {
  apostropheVariants: "’‘ʻʼ`´",
  numbers: {
    "nol": 0, "bir": 1, "ikki": 2, "uch": 3, "to'rt": 4, "besh": 5,
    "olti": 6, "yetti": 7, "sakkiz": 8, "to'qqiz": 9,
    "o'n": 10, "yigirma": 20, "o'ttiz": 30, "qirq": 40, "ellik": 50,
    "oltmish": 60, "yetmish": 70, "sakson": 80, "to'qson": 90,
    "ноль": 0, "бир": 1, "икки": 2, "уч": 3, "тўрт": 4, "торт": 4, "турт": 4,
    "беш": 5, "олти": 6, "етти": 7, "йетти": 7, "саккиз": 8, "тўққиз": 9, "токкиз": 9,
    "ўн": 10, "он": 10, "йигирма": 20, "ўттиз": 30, "оттиз": 30, "қирқ": 40, "кирк": 40,
    "эллик": 50, "олтмиш": 60, "етмиш": 70, "йетмиш": 70, "саксон": 80,
    "тўқсон": 90, "токсон": 90,
    "один": 1, "одна": 1, "одно": 1, "два": 2, "две": 2, "три": 3, "четыре": 4,
    "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
    "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
    "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18,
    "девятнадцать": 19, "двадцать": 20, "тридцать": 30, "сорок": 40,
    "пятьдесят": 50, "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80,
    "девяносто": 90, "двести": 200, "триста": 300, "четыреста": 400,
    "пятьсот": 500, "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900
  },
  hundreds: { "yuz": 100, "юз": 100, "сто": 100 },
  thousands: {
    "ming": 1000, "минг": 1000, "тысяча": 1000, "тысячи": 1000, "тысяч": 1000,
    "million": 1000000, "миллион": 1000000, "млн": 1000000, "млн.": 1000000
  },
  counterSuffixes: ["ta", "та"],
  corrections: {
    "ikta": "ikkita", "ixta": "ikkita", "ikuste": "ikkita",
    "икта": "иккита", "ихта": "иккита", "икусте": "иккита",
    "vilko": "vilka", "вилко": "вилка"
  },
  phrases: { "plastik vilko": "plastik vilka", "пластик вилко": "пластик вилка" },
  units: {
    "dona": "шт", "дона": "шт", "ta": "шт", "та": "шт", "juft": "пар", "жуфт": "пар",
    "qop": "мешок", "қоп": "мешок", "коп": "мешок", "korobka": "коробка",
    "quti": "коробка", "қути": "коробка", "upakovka": "упаковка", "упаковка": "упаковка",
    "upak": "уп", "упак": "уп", "kg": "кг", "кг": "кг", "kilogramm": "кг",
    "килограмм": "кг", "litr": "л", "литр": "л"
  },
  selfCorrectionMarkers: [
    "yo'q", "yoq", "йук", "йўқ", "нет", "net", "ne", "eee", "ee", "ээ", "эээ",
    "ya'ni", "яни", "yani", "aniqrog'i", "aniqrogi", "аниқроғи", "аникроги",
    "to'g'risi", "togrisi", "тўғриси", "тогриси"
  ]
};

function normalizeApostrophes(text: string): string {
  let out = String(text == null ? "" : text);
  for (const ch of D.apostropheVariants) out = out.split(ch).join("'");
  return out;
}
function lc(s: string): string { return normalizeApostrophes(s).toLowerCase(); }

function isNumberWord(word: string): boolean {
  const k = lc(word);
  return k in D.numbers || k in D.hundreds || k in D.thousands;
}

function runValue(words: string[]): number {
  let total = 0, current = 0;
  for (const w of words) {
    const k = lc(w);
    if (k in D.hundreds) current = (current === 0 ? 1 : current) * D.hundreds[k];
    else if (k in D.thousands) { current = (current === 0 ? 1 : current); total += current * D.thousands[k]; current = 0; }
    else current += D.numbers[k] || 0;
  }
  return total + current;
}

function esc(s: string): string { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

interface Tok { word: boolean; s: string; }
function tokenize(text: string): Tok[] {
  const m = String(text).match(/[\p{L}\p{N}']+|[^\p{L}\p{N}']+/gu);
  if (!m) return [];
  return m.map((s) => ({ word: /[\p{L}\p{N}']/u.test(s), s }));
}
function isWhitespace(t: Tok): boolean { return !!t && !t.word && /^\s+$/.test(t.s); }

// deno-lint-ignore no-explicit-any
function applyPhrases(text: string, corrections: any[]): string {
  let out = text;
  for (const from of Object.keys(D.phrases)) {
    const to = D.phrases[from];
    out = out.replace(new RegExp(esc(from), "giu"), (mm: string) => { corrections.push({ type: "phrase", from: mm, to }); return to; });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function applyWordCorrections(tokens: Tok[], corrections: any[]): Tok[] {
  const suffixes: string[] = D.counterSuffixes || [];
  const out: Tok[] = [];
  for (const token of tokens) {
    if (!token.word) { out.push(token); continue; }
    let s = token.s;
    const corrected = D.corrections[lc(s)];
    if (corrected != null && lc(s) !== lc(corrected)) { corrections.push({ type: "word", from: s, to: corrected }); s = corrected; }
    const key = lc(s);
    let split: string[] | null = null;
    for (const suf of suffixes) {
      if (key.length > suf.length && key.slice(-suf.length) === suf) {
        const stem = s.slice(0, s.length - suf.length);
        if (isNumberWord(stem)) { split = [stem, s.slice(s.length - suf.length)]; break; }
      }
    }
    if (split) { out.push({ word: true, s: split[0] }); out.push({ word: false, s: " " }); out.push({ word: true, s: split[1] }); }
    else out.push({ word: true, s });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function foldNumbers(tokens: Tok[], corrections: any[]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = tokens.length;
  while (i < n) {
    if (tokens[i].word && isNumberWord(tokens[i].s)) {
      let last = i, j = i + 1;
      while (j + 1 < n && isWhitespace(tokens[j]) && tokens[j + 1].word && isNumberWord(tokens[j + 1].s)) { last = j + 1; j = last + 1; }
      const words: string[] = [];
      let raw = "";
      for (let p = i; p <= last; p++) { raw += tokens[p].s; if (tokens[p].word) words.push(tokens[p].s); }
      const value = String(runValue(words));
      corrections.push({ type: "number", from: raw.trim(), to: value });
      out.push({ word: true, s: value });
      i = last + 1;
    } else { out.push(tokens[i]); i++; }
  }
  return out;
}

function detectSelfCorrections(text: string): string[] {
  const set: Record<string, boolean> = {};
  for (const m of (D.selfCorrectionMarkers || [])) set[lc(m)] = true;
  const found: string[] = [], seen: Record<string, boolean> = {};
  for (const t of tokenize(text)) {
    if (!t.word) continue;
    const k = lc(t.s);
    if (set[k] && !seen[k]) { seen[k] = true; found.push(t.s); }
  }
  return found;
}

function collapseSpaces(text: string): string {
  return String(text).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

export function normalizeTranscript(input: string) {
  const raw = String(input == null ? "" : input);
  // deno-lint-ignore no-explicit-any
  const corrections: any[] = [];
  let text = normalizeApostrophes(raw);
  const selfCorrections = detectSelfCorrections(text);
  text = applyPhrases(text, corrections);
  let tokens = tokenize(text);
  tokens = applyWordCorrections(tokens, corrections);
  tokens = foldNumbers(tokens, corrections);
  const normalized = collapseSpaces(tokens.map((t) => t.s).join(""));
  return { raw, text: normalized, corrections, selfCorrections, hadSelfCorrection: selfCorrections.length > 0 };
}
