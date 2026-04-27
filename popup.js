// PromptLens Popup Script v4.0 — Groq + Gemini auto-detect

const GROQ_TEST_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_TEST_URL = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
const GOOGLE_SIGN_IN_BUTTON_HTML = `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google`;

function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("AIza")) return "gemini";
  return key.length > 50 ? "groq" : "gemini";
}

function providerLabel(provider) {
  if (provider === "groq")   return { badge: "GROQ",   footer: "Llama 3.3 70B · Groq · temp 0.2" };
  if (provider === "gemini") return { badge: "GEMINI", footer: "Gemini 2.0 Flash · Google · temp 0.2" };
  return { badge: "–", footer: "PromptLens · No key saved" };
}

function updateProviderUI(key) {
  const provider = detectProvider(key);
  const { badge, footer } = providerLabel(provider);
  const badgeEl = document.getElementById("provider-badge");
  const footerEl = document.getElementById("footer-model");
  if (badgeEl) {
    badgeEl.textContent = badge;
    badgeEl.className = "provider-badge" + (provider ? ` provider-${provider}` : "");
  }
  if (footerEl) footerEl.textContent = footer;
}

// ── Screen management ─────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.style.display = "none");
  document.getElementById(id).style.display = "block";
}

function resetGoogleSignInButton() {
  const btn = document.getElementById("google-sign-in");
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = GOOGLE_SIGN_IN_BUTTON_HTML;
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  showScreen("screen-loading");
  const { plUser } = await chrome.storage.local.get("plUser");
  if (plUser?.uid) {
    initMainScreen(plUser);
  } else {
    showScreen("screen-login");
    resetGoogleSignInButton();
  }
});

// ── Login screen ──────────────────────────────────────────────────────────────
document.getElementById("google-sign-in").addEventListener("click", async () => {
  const btn = document.getElementById("google-sign-in");
  const errEl = document.getElementById("login-err");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const user = await signInWithGoogle();
    initMainScreen(user);
  } catch (err) {
    errEl.textContent = "Sign in failed: " + err.message;
    resetGoogleSignInButton();
  }
});

// ── Main screen init ──────────────────────────────────────────────────────────
function initMainScreen(user) {
  showScreen("screen-main");
  document.getElementById("user-email").textContent = user.email || user.displayName;

  // Load saved API key and update UI
  chrome.storage.local.get("plApiKey", ({ plApiKey }) => {
    if (plApiKey) {
      document.getElementById("key-input").value = plApiKey;
      updateProviderUI(plApiKey);
    }
  });

  // Sign out
  document.getElementById("sign-out-btn").addEventListener("click", async () => {
    await signOut();
    showScreen("screen-login");
    document.getElementById("login-err").textContent = "";
    resetGoogleSignInButton();
  });

  const keyInput  = document.getElementById("key-input");
  const saveBtn   = document.getElementById("save-btn");
  const testBtn   = document.getElementById("test-btn");
  const clearBtn  = document.getElementById("clear-btn");
  const eyeBtn    = document.getElementById("eye-btn");
  const eyeIcon   = document.getElementById("eye-icon");
  const statusMsg = document.getElementById("status-msg");

  // Live badge update as user types
  keyInput.addEventListener("input", () => updateProviderUI(keyInput.value.trim()));

  let visible = false;
  eyeBtn.addEventListener("click", () => {
    visible = !visible;
    keyInput.type = visible ? "text" : "password";
    eyeIcon.innerHTML = visible
      ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  });

  saveBtn.addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (!key) { flash(statusMsg, "Enter a key first", "error"); return; }
    chrome.storage.local.set({ plApiKey: key }, () => {
      updateProviderUI(key);
      const provider = detectProvider(key);
      flash(statusMsg, `✓ ${provider === "gemini" ? "Gemini" : "Groq"} key saved!`, "success");
    });
  });

  testBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) { flash(statusMsg, "Enter a key first", "error"); return; }
    const provider = detectProvider(key);
    testBtn.disabled = true;
    testBtn.innerHTML = `<div style="width:12px;height:12px;border:1.5px solid rgba(255,255,255,0.2);border-top-color:currentColor;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></div> Testing…`;
    try {
      let resp;
      if (provider === "gemini") {
        resp = await fetch(GEMINI_TEST_URL(key), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } })
        });
      } else {
        resp = await fetch(GROQ_TEST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], max_tokens: 5 })
        });
      }
      if (resp.ok) {
        flash(statusMsg, `✓ ${provider === "gemini" ? "Gemini" : "Groq"} connection successful!`, "success");
      } else {
        const e = await resp.json();
        flash(statusMsg, "⚠ " + (e?.error?.message || `HTTP ${resp.status}`), "error");
      }
    } catch (e) {
      flash(statusMsg, "⚠ Network error", "error");
    } finally {
      testBtn.disabled = false;
      testBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Test`;
    }
  });

  clearBtn.addEventListener("click", () => {
    chrome.storage.local.remove("plApiKey");
    keyInput.value = "";
    updateProviderUI("");
    flash(statusMsg, "Key cleared.", "neutral");
  });

  // History
  document.getElementById("history-btn").addEventListener("click", () => {
    const list = document.getElementById("history-list");
    if (list.children.length > 0) { list.innerHTML = ""; document.getElementById("history-btn").textContent = "Show"; return; }
    chrome.storage.local.get({ plHistory: [] }, ({ plHistory }) => {
      renderHistory(plHistory);
      document.getElementById("history-btn").textContent = "Hide";
    });
  });

  document.getElementById("clear-history-btn").addEventListener("click", () => {
    chrome.storage.local.set({ plHistory: [] });
    document.getElementById("history-list").innerHTML = `<div class="hist-empty">History cleared.</div>`;
    document.getElementById("history-btn").textContent = "Show";
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function flash(el, msg, type) {
  el.textContent = msg;
  el.className = "status-msg show " + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3000);
}

function renderHistory(items) {
  const list = document.getElementById("history-list");
  if (!items.length) { list.innerHTML = `<div class="hist-empty">No history yet.</div>`; return; }
  list.innerHTML = items.slice(0, 20).map(item => {
    const time = new Date(item.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const preview = (item.original || "").slice(0, 80).replace(/\n/g, " ");
    const typeClass = item.mode === "refine" ? "hist-type-refine" : item.mode === "json" ? "hist-type-json" : "hist-type-explain";
    return `
      <div class="hist-item">
        <div class="hist-top">
          <span class="hist-type ${typeClass}">${item.mode}</span>
          <span class="hist-time">${time}</span>
        </div>
        <div class="hist-preview">${escHtml(preview)}${item.original?.length > 80 ? "…" : ""}</div>
      </div>`;
  }).join("");
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const style = document.createElement("style");
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);


