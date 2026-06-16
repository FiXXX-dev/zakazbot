// Конфигурация ZakazBot. Файл хранится в репозитории (нужен GitHub Pages) —
// только публичные значения. OPENAI_API_KEY здесь всегда пустой; для режима
// "direct" вписывайте ключ только локально и не коммитьте.

window.CONFIG = {
  // Проект Supabase: Settings → API
  SUPABASE_URL: "https://srsfkuritnjjzrmjorpu.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyc2ZrdXJpdG5qanpybWpvcnB1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTI0MTQsImV4cCI6MjA5Njg2ODQxNH0.Q9FM4vjTvoGjpKz_-ujU7pYUJFRPhdKC7X5FEgG55Xg",

  // Режим обращения к OpenAI:
  //   "edge"   — через Supabase Edge Function (по умолчанию).
  //              Ключ OpenAI хранится в секретах Supabase и НЕ попадает в браузер.
  //   "direct" — напрямую из браузера. ТОЛЬКО для локального теста!
  OPENAI_MODE: "edge",

  // Имя Edge Function-прокси — должно совпадать с именем функции в дашборде Supabase.
  EDGE_FUNCTION_NAME: "openaiproxy",

  // Email администратора — на него уходит заявка «Upgrade на Pro» из settings.html.
  ADMIN_EMAIL: "nurmuhamedovsa@gmail.com",

  // Username Telegram-бота (без @) — для ссылок-приглашений клиентов в админке.
  TELEGRAM_BOT_USERNAME: "zakaaaz_bot",

  // Пароль админки (admin-dashboard.html) здесь НЕ хранится: он проверяется на
  // сервере в Edge Function clientauth. Задайте секрет в Supabase:
  //   supabase secrets set ADMIN_PANEL_SECRET=<ваш_пароль>


  // Заполняется ТОЛЬКО для OPENAI_MODE="direct" при локальной отладке.
  // Никогда не публикуйте файл с заполненным ключом.
  OPENAI_API_KEY: ""
};
