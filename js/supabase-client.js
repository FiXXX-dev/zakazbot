// Инициализация клиента Supabase.
//
// ВАЖНО: window.supabase — это UMD-библиотека supabase-js (загружена с CDN),
// а window.sb — созданный клиент. Все обращения к БД делаются ТОЛЬКО через
// window.sb.from(...). Никогда не используйте window.supabase.from(...).

(function () {
  window.sb = null;

  var cfg = window.CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
      cfg.SUPABASE_URL.indexOf("YOUR-PROJECT") !== -1 ||
      cfg.SUPABASE_ANON_KEY === "YOUR-ANON-KEY") {
    console.warn("[ZakazBot] config.js отсутствует или не заполнен — Supabase отключён. " +
      "Скопируйте config.example.js в config.js и заполните ключи.");
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("[ZakazBot] Библиотека supabase-js не загрузилась (проверьте доступ к CDN).");
    return;
  }

  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
})();
