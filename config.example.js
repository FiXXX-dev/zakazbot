// Конфигурация ZakazBot.
// Скопируйте этот файл в config.js и заполните значения:
//   cp config.example.js config.js
// config.js добавлен в .gitignore — реальные ключи не попадут в репозиторий.

window.CONFIG = {
  // Проект Supabase: Settings → API
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",

  // Режим обращения к OpenAI:
  //   "edge"   — через Supabase Edge Function "openai-proxy" (по умолчанию).
  //              Ключ OpenAI хранится в секретах Supabase и НЕ попадает в браузер.
  //   "direct" — напрямую из браузера. ТОЛЬКО для локального теста!
  OPENAI_MODE: "edge",

  // Заполняется ТОЛЬКО для OPENAI_MODE="direct" при локальной отладке.
  // Никогда не публикуйте файл с заполненным ключом.
  OPENAI_API_KEY: ""
};
