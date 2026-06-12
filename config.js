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
  // Заполняется ТОЛЬКО для OPENAI_MODE="direct" при локальной отладке.
  // Никогда не публикуйте файл с заполненным ключом.
  OPENAI_API_KEY: ""
};
