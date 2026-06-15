// Страница входа/регистрации (login.html) через Supabase Auth.
// При успешном входе с активной сессией → переход в приложение (index.html).

(function () {
  const els = {
    setup: document.getElementById("setup-warning"),
    title: document.getElementById("auth-title"),
    tabs: document.getElementById("auth-tabs"),
    companyField: document.getElementById("company-field"),
    company: document.getElementById("auth-company"),
    email: document.getElementById("auth-email"),
    password: document.getElementById("auth-password"),
    submit: document.getElementById("auth-submit"),
    msg: document.getElementById("auth-msg")
  };

  let mode = "signin"; // signin | signup

  if (!window.sb) {
    els.setup.innerHTML =
      '<div class="msg msg-warn">Supabase не настроен: заполните <code>config.js</code> (URL и anon-ключ). Вход недоступен.</div>';
    els.submit.disabled = true;
    return;
  }

  // Уже залогинен — сразу в приложение.
  window.sb.auth.getSession().then(function (res) {
    if (res && res.data && res.data.session) location.replace("index.html");
  });

  els.tabs.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () { setMode(btn.dataset.mode); });
  });
  els.submit.addEventListener("click", onSubmit);
  els.password.addEventListener("keydown", function (e) { if (e.key === "Enter") onSubmit(); });

  function setMode(next) {
    mode = next;
    els.tabs.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mode === next);
    });
    const signup = next === "signup";
    els.title.textContent = signup ? "Регистрация" : "Вход";
    els.submit.textContent = signup ? "Зарегистрироваться" : "Войти";
    els.companyField.style.display = signup ? "" : "none";
    els.password.setAttribute("autocomplete", signup ? "new-password" : "current-password");
    els.msg.innerHTML = "";
  }

  async function onSubmit() {
    const email = els.email.value.trim();
    const password = els.password.value;
    if (!email || !password) {
      show("warn", "Введите email и пароль.");
      return;
    }
    if (mode === "signup" && password.length < 6) {
      show("warn", "Пароль должен быть не менее 6 символов.");
      return;
    }

    els.submit.disabled = true;
    show("info", '<span class="spinner"></span> ' + (mode === "signup" ? "Регистрирую…" : "Вхожу…"));
    try {
      if (mode === "signup") {
        const { data, error } = await window.sb.auth.signUp({
          email: email,
          password: password,
          options: { data: { company: els.company.value.trim() } }
        });
        if (error) throw error;
        if (data && data.session) {
          location.replace("index.html"); // подтверждение email выключено — сразу внутрь
        } else {
          show("success", "Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.");
          setMode("signin");
        }
      } else {
        const { error } = await window.sb.auth.signInWithPassword({ email: email, password: password });
        if (error) throw error;
        location.replace("index.html");
      }
    } catch (e) {
      show("error", "Ошибка: " + esc(e && e.message ? e.message : String(e)));
    } finally {
      els.submit.disabled = false;
    }
  }

  function show(type, html) {
    els.msg.innerHTML = '<div class="msg msg-' + type + '">' + html + "</div>";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
