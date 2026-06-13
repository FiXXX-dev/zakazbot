// Нормализация транскрипции — отдельный этап между Whisper и GPT.
//
// window.Normalizer.normalizeTranscript(text) → {
//   raw, text, corrections:[{type,from,to}], selfCorrections:[…], hadSelfCorrection
// }
//
// Что делает:
//   1. Приводит варианты апострофа к "'".
//   2. Исправляет типичные ошибки распознавания (словарь corrections/phrases).
//   3. Отделяет узбекский счётный суффикс (ikkita → ikki ta).
//   4. Сворачивает узбекские и русские числительные в цифры (ikki yuz → 200).
//   5. Находит маркеры самоисправления клиента (yo'q, йук, ээ, ya'ni …).
//
// Словарь — в js/dictionary.js (window.ZakazDictionary), пополняется без правки
// этого файла. Логика устойчива к смешанной русско-узбекской речи (оба алфавита).

(function () {
  function dict() {
    return window.ZakazDictionary || {
      apostropheVariants: "", numbers: {}, hundreds: {}, thousands: {},
      counterSuffixes: [], corrections: {}, phrases: {}, units: {}, selfCorrectionMarkers: []
    };
  }

  // Все варианты апострофа → "'". Без этого "o‘n" и "o'n" считались бы разными.
  function normalizeApostrophes(text) {
    const variants = dict().apostropheVariants || "";
    let out = String(text == null ? "" : text);
    for (const ch of variants) out = out.split(ch).join("'");
    return out;
  }

  function lc(s) {
    return normalizeApostrophes(s).toLowerCase();
  }

  function isNumberWord(word) {
    const d = dict();
    const key = lc(word);
    return key in d.numbers || key in d.hundreds || key in d.thousands;
  }

  // Значение последовательности числительных (аддитивно-мультипликативно):
  // "ikki yuz ellik" → 2·100 + 50 = 250, "besh ming" → 5000, "ming" → 1000.
  function runValue(words) {
    const d = dict();
    let total = 0, current = 0;
    words.forEach(function (w) {
      const key = lc(w);
      if (key in d.hundreds) {
        current = (current === 0 ? 1 : current) * d.hundreds[key];
      } else if (key in d.thousands) {
        current = (current === 0 ? 1 : current);
        total += current * d.thousands[key];
        current = 0;
      } else {
        current += d.numbers[key] || 0;
      }
    });
    return total + current;
  }

  // Экранирует спецсимволы регулярного выражения.
  function esc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Разбивает текст на чередующиеся куски: слово (буквы/цифры/апостроф) и
  // разделитель (всё остальное). Так нормализация не задевает пунктуацию и регистр.
  function tokenize(text) {
    const matches = String(text).match(/[\p{L}\p{N}']+|[^\p{L}\p{N}']+/gu);
    if (!matches) return [];
    return matches.map(function (s) {
      return { word: /[\p{L}\p{N}']/u.test(s), s: s };
    });
  }

  function isWhitespace(token) {
    return token && !token.word && /^\s+$/.test(token.s);
  }

  // Замена словосочетаний (несколько слов) по словарю phrases.
  function applyPhrases(text, corrections) {
    const phrases = dict().phrases || {};
    let out = text;
    Object.keys(phrases).forEach(function (from) {
      const to = phrases[from];
      const re = new RegExp(esc(from), "giu");
      out = out.replace(re, function (m) {
        corrections.push({ type: "phrase", from: m, to: to });
        return to;
      });
    });
    return out;
  }

  // Пословные исправления + отделение счётного суффикса (ikkita → ikki ta).
  // Возвращает новый массив токенов (некоторые слова разворачиваются в три токена).
  function applyWordCorrections(tokens, corrections) {
    const d = dict();
    const suffixes = d.counterSuffixes || [];
    const out = [];

    tokens.forEach(function (token) {
      if (!token.word) { out.push(token); return; }

      let s = token.s;
      const corrected = d.corrections[lc(s)];
      if (corrected != null && lc(s) !== lc(corrected)) {
        corrections.push({ type: "word", from: s, to: corrected });
        s = corrected;
      }

      // Отделяем счётный суффикс, если остаток — числительное (yuzta → yuz ta).
      const key = lc(s);
      let split = null;
      for (let i = 0; i < suffixes.length; i++) {
        const suf = suffixes[i];
        if (key.length > suf.length && key.slice(-suf.length) === suf) {
          const stem = s.slice(0, s.length - suf.length);
          if (isNumberWord(stem)) { split = [stem, s.slice(s.length - suf.length)]; break; }
        }
      }

      if (split) {
        out.push({ word: true, s: split[0] });
        out.push({ word: false, s: " " });
        out.push({ word: true, s: split[1] });
      } else {
        out.push({ word: true, s: s });
      }
    });

    return out;
  }

  // Сворачивает подряд идущие числительные (через пробелы) в одно число.
  function foldNumbers(tokens, corrections) {
    const out = [];
    let i = 0;
    const n = tokens.length;

    while (i < n) {
      if (tokens[i].word && isNumberWord(tokens[i].s)) {
        let last = i;       // индекс последнего числительного в серии
        let j = i + 1;
        while (j + 1 < n && isWhitespace(tokens[j]) &&
               tokens[j + 1].word && isNumberWord(tokens[j + 1].s)) {
          last = j + 1;
          j = last + 1;
        }

        const words = [];
        let rawRun = "";
        for (let p = i; p <= last; p++) {
          rawRun += tokens[p].s;
          if (tokens[p].word) words.push(tokens[p].s);
        }
        const value = String(runValue(words));
        corrections.push({ type: "number", from: rawRun.trim(), to: value });
        out.push({ word: true, s: value });
        i = last + 1;
      } else {
        out.push(tokens[i]);
        i++;
      }
    }
    return out;
  }

  function detectSelfCorrections(text) {
    const markers = dict().selfCorrectionMarkers || [];
    const set = {};
    markers.forEach(function (m) { set[lc(m)] = true; });
    const found = [];
    const seen = {};
    tokenize(text).forEach(function (token) {
      if (!token.word) return;
      const key = lc(token.s);
      if (set[key] && !seen[key]) { seen[key] = true; found.push(token.s); }
    });
    return found;
  }

  function collapseSpaces(text) {
    return String(text).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  }

  function normalizeTranscript(input) {
    const raw = String(input == null ? "" : input);
    const corrections = [];

    let text = normalizeApostrophes(raw);
    const selfCorrections = detectSelfCorrections(text);

    text = applyPhrases(text, corrections);
    let tokens = tokenize(text);
    tokens = applyWordCorrections(tokens, corrections);
    tokens = foldNumbers(tokens, corrections);

    const normalized = collapseSpaces(tokens.map(function (t) { return t.s; }).join(""));

    return {
      raw: raw,
      text: normalized,
      corrections: corrections,
      selfCorrections: selfCorrections,
      hadSelfCorrection: selfCorrections.length > 0
    };
  }

  window.Normalizer = {
    normalizeTranscript: normalizeTranscript,
    // Псевдоним под именем из ТЗ (normalize_transcript).
    normalize_transcript: normalizeTranscript
  };
})();
