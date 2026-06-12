// Конфигурация ZakazBot. Файл хранится в репозитории (нужен GitHub Pages) —
// только публичные значения. OPENAI_API_KEY здесь всегда пустой; для режима
// "direct" вписывайте ключ только локально и не коммитьте.

window.CONFIG = {
  // Проект Supabase: Settings → API
  SUPABASE_URL: "https://srsfkuritnjjzrmjorpu.supabase.co",
  SUPABASE_ANON_KEY: "НОВЫЙ_КЛЮЧ_ПОСЛЕ_СБРОСА", // ← замените на реальный anon-ключ: Supabase → Settings → API

  // Режим обращения к OpenAI:
  //   "edge"   — через Supabase Edge Function "openai-proxy" (по умолчанию).
  //              Ключ OpenAI хранится в секретах Supabase и НЕ попадает в браузер.
  //   "direct" — напрямую из браузера. ТОЛЬКО для локального теста!
  OPENAI_MODE: "edge",

  // Заполняется ТОЛЬКО для OPENAI_MODE="direct" при локальной отладке.
  // Никогда не публикуйте файл с заполненным ключом.
  OPENAI_API_KEY: ""
};
