// Шаблон конфигурации ZakazBot. Рабочий файл — config.js, он хранится в
// репозитории и содержит ТОЛЬКО публичные значения (URL и anon-ключ Supabase).
// Ключ OpenAI в config.js не вписывать — он живёт в секретах Supabase
// (режим "edge"); для режима "direct" — только локально и не коммитить.

window.CONFIG = {
  // Проект Supabase: Settings → API
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",

  // Режим обращения к OpenAI:
  //   "edge"   — через Supabase Edge Function "openaiproxy" (по умолчанию).
  //              Ключ OpenAI хранится в секретах Supabase и НЕ попадает в браузер.
  //   "direct" — напрямую из браузера. ТОЛЬКО для локального теста!
  OPENAI_MODE: "edge",

  // Имя Edge Function-прокси (если в дашборде Supabase функция названа иначе).
  EDGE_FUNCTION_NAME: "openaiproxy",

  // Email администратора — на него уходит заявка «Upgrade на Pro» из settings.html.
  ADMIN_EMAIL: "you@example.com",

  // Username Telegram-бота (без @) — для ссылок-приглашений клиентов в админке.
  TELEGRAM_BOT_USERNAME: "your_bot",

  // Пароль админки (admin-dashboard.html) здесь НЕ хранится — он в секрете
  // Supabase: supabase secrets set ADMIN_PANEL_SECRET=<ваш_пароль>


  // Заполняется ТОЛЬКО для OPENAI_MODE="direct" при локальной отладке.
  // Никогда не публикуйте файл с заполненным ключом.
  OPENAI_API_KEY: ""
};
