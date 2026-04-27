// PromptLens Content Script v3
(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────
  let selBar = null;
  let prefDropdown = null;
  let savedRange = null;
  let savedText = "";
  let savedActiveEl = null;
  let savedSelStart = -1;
  let savedSelEnd = -1;
  let currentPreference = "";
  let lastMode = "refine"; // track last used mode for Explain
  // One-shot gate: selection UI appears only after explicit activation.
  let selectionActivationArmed = false;
  // Last refinement metadata used for structured feedback logging.
  let lastRefineMeta = {
    original_prompt: "",
    refined_prompt: "",
    mode: "refine",
    applied_rules: []
  };

  // ── Load saved preference ─────────────────────────────────────────────────
  chrome.storage.local.get(["plPreference"], ({ plPreference }) => {
    if (plPreference) currentPreference = plPreference;
  });

  // ── Capture selection ─────────────────────────────────────────────────────
  document.addEventListener("contextmenu", captureSelection);
  document.addEventListener("mouseup", onPointerUp);
  // Ctrl+Shift+M = toggle bar on/off
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "M") {
      e.preventDefault();
      if (selBar) {
        hideSelBar();
        selectionActivationArmed = false;
        return;
      }
      selectionActivationArmed = true;
      captureSelection();
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 2) {
        positionSelBar(e);
      }
    }
  });

  function onPointerUp(e) {
    if (e.target?.closest?.(".pl-sel-bar, .pl-overlay, .pl-feedback-wrap, .pl-toast, .pl-pref-drop")) return;
    if (!selectionActivationArmed) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 2) {
        captureSelection();
        positionSelBar(e);
      }
    }, 20);
  }

  function updateLastRefineMeta({ originalPrompt, refinedPrompt, mode, appliedRules }) {
    const cleanRules = Array.isArray(appliedRules)
      ? appliedRules.filter(Boolean).map(String)
      : [];
    lastRefineMeta = {
      original_prompt: String(originalPrompt || ""),
      refined_prompt: String(refinedPrompt || ""),
      mode: String(mode || "refine"),
      applied_rules: cleanRules
    };
  }

  function buildFeedbackPayload(rating) {
    const originalPrompt = lastRefineMeta.original_prompt || savedText || "";
    const refinedPrompt = lastRefineMeta.refined_prompt || originalPrompt;
    return {
      original_prompt: originalPrompt,
      refined_prompt: refinedPrompt,
      mode: lastRefineMeta.mode || lastMode || "refine",
      rating: Number.isFinite(rating) ? rating : 0,
      timestamp: new Date().toISOString(),
      applied_rules: Array.isArray(lastRefineMeta.applied_rules) ? lastRefineMeta.applied_rules : []
    };
  }

  function captureSelection() {
    const sel = window.getSelection();
    savedText = sel?.toString().trim() || savedText;
    if (sel?.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
    savedActiveEl = document.activeElement;
    if (savedActiveEl && (savedActiveEl.tagName === "TEXTAREA" || savedActiveEl.tagName === "INPUT")) {
      savedSelStart = savedActiveEl.selectionStart;
      savedSelEnd = savedActiveEl.selectionEnd;
    }
  }

  // ── Floating Selection Bar ─────────────────────────────────────────────────
  function positionSelBar(e) {
    // One-shot behavior: consume activation once the dialog is shown.
    selectionActivationArmed = false;
    hideSelBar();
    selBar = document.createElement("div");
    selBar.className = "pl-sel-bar";

    const displayPref = currentPreference || "Normal";
    const prefLabel = `<span class="pl-pref-tag ${!currentPreference ? 'pl-pref-default' : ''}">✦ ${esc(displayPref.slice(0, 18))}${displayPref.length > 18 ? "…" : ""}</span>`;

    selBar.innerHTML = `
      ${prefLabel}
      <div class="pl-bar-main">
        <button class="pl-sb-btn pl-sb-refine" title="Rewrite as clear, improved prompt">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Refine
        </button>
        <button class="pl-sb-btn pl-sb-json" title="Rewrite as structured JSON prompt (role, task, context...)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          JSON
        </button>
        <div class="pl-sb-sep"></div>
        <button class="pl-sb-btn pl-sb-explain" title="Score & analyze against 10 prompting principles">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          Explain
        </button>
        <div class="pl-sb-sep"></div>
        <button class="pl-sb-btn pl-sb-pref" title="Set output style preference" id="pl-pref-btn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
          Preference
        </button>
        <button class="pl-sb-btn pl-sb-feedback" title="Send feedback">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Feedback
        </button>
      </div>
    `;

    document.body.appendChild(selBar);

    // Position bar near selected text
    const bW = 380;
    let x, y;

    // Helper: check if coordinates are in a valid visible area
    const isValid = (px, py) =>
      px > 100 && py > 80 &&
      px < (window.scrollX + window.innerWidth - 50) &&
      py < (window.scrollY + window.innerHeight - 50);

    // 1st: textarea/input — use element rect directly (window.getSelection
    //      returns zero rects for textarea, so we must use element position)
    const el = document.activeElement || savedActiveEl;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.top > 0) {
        x = r.left + window.scrollX + r.width / 2;
        // Position bar just above the textarea
        y = r.top + window.scrollY - 8;
      }
    }

    // 2nd: contenteditable — use selection range bounding rect
    if (!isValid(x, y)) {
      const sel = window.getSelection();
      if (sel?.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width > 0 && r.top > 0 && r.top < window.innerHeight) {
          x = r.left + window.scrollX + r.width / 2;
          y = r.top + window.scrollY;
        }
      }
    }

    // 3rd: savedRange from captureSelection
    if (!isValid(x, y) && savedRange) {
      try {
        const r = savedRange.getBoundingClientRect();
        if (r.width > 0 && r.top > 0 && r.top < window.innerHeight) {
          x = r.left + window.scrollX + r.width / 2;
          y = r.top + window.scrollY;
        }
      } catch (_) {}
    }

    // 4th: mouse event (only if clearly within viewport)
    if (!isValid(x, y) && e instanceof MouseEvent && isValid(e.pageX, e.pageY)) {
      x = e.pageX;
      y = e.pageY;
    }

    // Final: center of viewport
    if (!isValid(x, y)) {
      x = window.scrollX + window.innerWidth / 2;
      y = window.scrollY + Math.min(280, window.innerHeight * 0.4);
    }

    let left = x - bW / 2;
    let top = y - 64;
    left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - bW - 8));
    top = Math.max(window.scrollY + 8, top);
    selBar.style.left = `${left}px`;
    selBar.style.top = `${top}px`;

    selBar.querySelector(".pl-sb-refine").onclick = () => runMode("refine");
    selBar.querySelector(".pl-sb-json").onclick = () => runMode("json");
    selBar.querySelector(".pl-sb-explain").onclick = () => runExplain();
    selBar.querySelector(".pl-sb-pref").onclick = (e) => { e.stopPropagation(); togglePrefDropdown(); };
    selBar.querySelector(".pl-sb-feedback").onclick = () => { hideSelBar(); showFeedbackModal(); };

    setTimeout(() => document.addEventListener("mousedown", onOutsideBar), 80);
  }

  function hideSelBar() {
    selBar?.remove(); selBar = null;
    prefDropdown?.remove(); prefDropdown = null;
    document.removeEventListener("mousedown", onOutsideBar);
  }

  function onOutsideBar(e) {
    if (selBar && !selBar.contains(e.target) && !prefDropdown?.contains(e.target)) hideSelBar();
  }

  function setBarLoading(label) {
    if (selBar) {
      const main = selBar.querySelector(".pl-bar-main");
      if (main) main.innerHTML = `<div class="pl-sb-loading"><div class="pl-sb-spinner"></div>${label}</div>`;
    }
  }

  // ── Preference Dropdown ────────────────────────────────────────────────────
  async function togglePrefDropdown() {
    if (prefDropdown) { prefDropdown.remove(); prefDropdown = null; return; }

    const { plPrefHistory = [] } = await chrome.storage.local.get("plPrefHistory");

    prefDropdown = document.createElement("div");
    prefDropdown.className = "pl-pref-drop";

    const historyHtml = plPrefHistory.length
      ? `<div class="pl-pref-hist-label">RECENT</div>
         <div class="pl-pref-hist">
           ${plPrefHistory.slice(0, 8).map(p =>
             `<button class="pl-pref-hist-item" data-val="${esc(p)}">${esc(p)}</button>`
           ).join("")}
         </div>`
      : "";

    prefDropdown.innerHTML = `
      <div class="pl-pref-title">Output Preference</div>
      <input class="pl-pref-input" id="pl-pref-input" type="text"
        placeholder="e.g. story type, precise, academic, ELI5…"
        value="${esc(currentPreference)}">
      ${historyHtml}
      <div class="pl-pref-btns">
        <button class="pl-pref-save" id="pl-pref-save">Apply</button>
        ${currentPreference ? `<button class="pl-pref-clear" id="pl-pref-clear">Clear</button>` : ""}
      </div>
    `;

    // Position below the bar
    const barRect = selBar.getBoundingClientRect();
    prefDropdown.style.position = "absolute";
    prefDropdown.style.top = `${barRect.bottom + window.scrollY + 6}px`;
    prefDropdown.style.left = `${barRect.left + window.scrollX}px`;
    document.body.appendChild(prefDropdown);

    // Focus input
    setTimeout(() => document.getElementById("pl-pref-input")?.focus(), 50);

    // History click
    prefDropdown.querySelectorAll(".pl-pref-hist-item").forEach(btn => {
      btn.onclick = () => {
        document.getElementById("pl-pref-input").value = btn.dataset.val;
      };
    });

    document.getElementById("pl-pref-save").onclick = savePreference;
    const clearBtn = document.getElementById("pl-pref-clear");
    if (clearBtn) clearBtn.onclick = clearPreference;

    document.getElementById("pl-pref-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") savePreference();
      if (e.key === "Escape") { prefDropdown?.remove(); prefDropdown = null; }
    });
  }

  async function savePreference() {
    const val = document.getElementById("pl-pref-input")?.value.trim() || "";
    currentPreference = val; // empty string = Normal
    
    // Persist — empty string means "Normal" (no override)
    if (val) {
      chrome.storage.local.set({ plPreference: val });
      const { plPrefHistory = [] } = await chrome.storage.local.get("plPrefHistory");
      const updated = [val, ...plPrefHistory.filter(p => p !== val)].slice(0, 20);
      chrome.storage.local.set({ plPrefHistory: updated });
    } else {
      chrome.storage.local.remove("plPreference");
    }

    prefDropdown?.remove(); prefDropdown = null;

    // Update preference tag in bar
    const tag = selBar?.querySelector(".pl-pref-tag");
    const displayVal = val || "Normal";
    if (tag) {
      tag.textContent = `✦ ${displayVal.slice(0, 18)}${displayVal.length > 18 ? "…" : ""}`;
      tag.className = `pl-pref-tag${!val ? " pl-pref-default" : ""}`;
    }

    showToast(val ? `✦ Preference set: ${val}` : "✦ Preference reset to Normal", "success");
  }

  function clearPreference() {
    currentPreference = "";
    chrome.storage.local.remove("plPreference");
    prefDropdown?.remove(); prefDropdown = null;
    const tag = selBar?.querySelector(".pl-pref-tag");
    if (tag) {
      tag.textContent = "✦ Normal";
      tag.className = "pl-pref-tag pl-pref-default";
    }
    showToast("✦ Preference reset to Normal", "info");
  }

  // ── API Key ───────────────────────────────────────────────────────────────
  async function getApiKey() {
    const { plApiKey } = await chrome.storage.local.get("plApiKey");
    return plApiKey || null;
  }

  // ── Output / JSON Mode ─────────────────────────────────────────────────────
  async function runMode(mode) {
    if (!savedText) return;
    const text = savedText;
    const range = savedRange;
    const el = savedActiveEl;
    const start = savedSelStart;
    const end = savedSelEnd;

    lastMode = mode;
    setBarLoading(mode === "json" ? "Structuring…" : "Refining…");

    const apiKey = await getApiKey();
    if (!apiKey) { hideSelBar(); showNoKeyToast(); return; }

    const res = await callProviderAI(mode, text, apiKey, currentPreference);
    hideSelBar();

    if (res.error) { showToast("⚠ " + res.error, "error"); return; }

    let insertText = String(res.result || "");

    // For JSON mode, pretty-print if valid JSON
    if (mode === "json") {
      try {
        const parsed = JSON.parse(insertText);
        insertText = JSON.stringify(parsed, null, 2);
      } catch (_) { /* use raw */ }
    }

    updateLastRefineMeta({
      originalPrompt: text,
      refinedPrompt: insertText,
      mode,
      appliedRules: res.meta?.appliedRules || []
    });

    replaceText(insertText, range, el, start, end, text);
    const label = mode === "json" ? "{ } JSON prompt injected" : "✓ Prompt refined";
    showToast(label, "success", "Undo", () => replaceText(text, range, el, start, start + insertText.length, insertText));
  }

  // ── Explain Mode ──────────────────────────────────────────────────────────
  async function runExplain() {
    if (!savedText) return;
    const text = savedText;

    setBarLoading("Analyzing…");

    const apiKey = await getApiKey();
    if (!apiKey) { hideSelBar(); showNoKeyToast(); return; }

    const res = await callProviderAI("explain", text, apiKey, currentPreference);
    hideSelBar();

    if (res.error) { showToast("⚠ " + res.error, "error"); return; }
    showExplainModal(text, res.result);
  }

  // ── Replace Text ──────────────────────────────────────────────────────────
  function replaceText(newText, range, el, start, end, originalText) {
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && start >= 0) {
      if (!el.dataset.plOriginal) el.dataset.plOriginal = el.value;
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
      const val = el.value;
      setter ? setter.call(el, val.slice(0, start) + newText + val.slice(end))
              : (el.value = val.slice(0, start) + newText + val.slice(end));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.selectionStart = el.selectionEnd = start + newText.length;
      return;
    }
    if (el?.isContentEditable && range) {
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      if (!el.dataset.plOriginal) el.dataset.plOriginal = originalText || "";
      try { document.execCommand("insertText", false, newText); return; } catch (_) {}
    }
    if (range) {
      try {
        range.deleteContents();
        const node = document.createTextNode(newText);
        range.insertNode(node);
        range.setStartAfter(node); range.setEndAfter(node);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
      } catch (_) { showToast("⚠ Could not replace text on this page", "error"); }
    }
  }

  // ── Explain Modal ─────────────────────────────────────────────────────────
  function showExplainModal(originalText, rawResult) {
    document.getElementById("pl-explain-modal")?.remove();

    let data = {};
    try { data = JSON.parse(rawResult); }
    catch { data = { rewritten: rawResult, summary: "", issues: [], score_before: null, score_after: null }; }

    const { rewritten = "", json_version, summary = "", issues = [], score_before, score_after } = data;

    const ICONS = {
      task_clarity: "🎯", missing_role: "👤", missing_context: "🔍",
      missing_format: "📋", vagueness: "🌫️", missing_constraints: "⛓️",
      missing_domain: "🔬", missing_tone: "🎭"
    };

    const PRINCIPLE_COLORS = {
      task_clarity: "#f87171", missing_role: "#c084fc", missing_context: "#60a5fa",
      missing_format: "#34d399", vagueness: "#fbbf24", missing_constraints: "#f97316",
      missing_domain: "#22d3ee", missing_tone: "#a78bfa"
    };

    const scoreHtml = (score_before != null && score_after != null) ? `
      <div class="pl-score-row">
        <div class="pl-score pl-score-b">
          <span class="pl-score-n">${score_before}</span>
          <span class="pl-score-l">BEFORE</span>
          <span class="pl-score-sub">/ 10</span>
        </div>
        <div class="pl-score-mid">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span class="pl-score-delta">+${Math.max(0, (score_after || 0) - (score_before || 0))}</span>
        </div>
        <div class="pl-score pl-score-a">
          <span class="pl-score-n">${score_after}</span>
          <span class="pl-score-l">AFTER</span>
          <span class="pl-score-sub">/ 10</span>
        </div>
      </div>` : "";

    const issuesHtml = issues.map(i => `
      <div class="pl-issue" style="border-left-color: ${PRINCIPLE_COLORS[i.type] || "#818cf8"}">
        <div class="pl-issue-top">
          <span class="pl-issue-icon">${ICONS[i.type] || "⚡"}</span>
          <span class="pl-issue-principle">${esc(i.principle || i.type || "")}</span>
        </div>
        <div class="pl-issue-problem">${esc(i.problem || "")}</div>
        <div class="pl-issue-fix">→ ${esc(i.fix || "")}</div>
      </div>`).join("");

    // Tab content
    const outputTab = rewritten;
    const jsonTab = json_version ? JSON.stringify(json_version, null, 2) : null;

    const modal = document.createElement("div");
    modal.id = "pl-explain-modal";
    modal.className = "pl-overlay";
    modal.innerHTML = `
      <div class="pl-modal" role="dialog">
        <div class="pl-modal-hdr">
          <div class="pl-modal-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            PromptLens Analysis
            <span class="pl-modal-badge">Scored by 10 Prompting Principles</span>
          </div>
          <button class="pl-modal-x" id="pl-mclose">✕</button>
        </div>

        ${scoreHtml}
        ${summary ? `<p class="pl-modal-summary">${esc(summary)}</p>` : ""}

        <div class="pl-compare">
          <div class="pl-compare-col">
            <div class="pl-compare-lbl pl-lbl-orig">ORIGINAL</div>
            <div class="pl-compare-text">${esc(originalText)}</div>
          </div>
          <div class="pl-compare-col">
            <div class="pl-compare-lbl-row">
              <div class="pl-compare-lbl pl-lbl-new">REWRITTEN</div>
              ${jsonTab ? `<div class="pl-rewrite-tabs">
                <button class="pl-rtab pl-rtab-active" id="pl-tab-output">Refine</button>
                <button class="pl-rtab" id="pl-tab-json">JSON</button>
              </div>` : ""}
            </div>
            <div class="pl-compare-text pl-compare-new" id="pl-rewritten-display">${esc(outputTab)}</div>
          </div>
        </div>

        ${issuesHtml ? `
          <div class="pl-sec-label">ISSUES IDENTIFIED (${issues.length})</div>
          <div class="pl-issues">${issuesHtml}</div>` : ""}

        <div class="pl-modal-ftr">
          <button class="pl-ftr-btn pl-ftr-copy" id="pl-copy-btn">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy Rewritten
          </button>
          <button class="pl-ftr-btn pl-ftr-replace" id="pl-replace-btn">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Refine &amp; Replace
          </button>
          ${jsonTab ? `<button class="pl-ftr-btn pl-ftr-json" id="pl-inject-json-btn">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            Inject JSON
          </button>` : ""}
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById("pl-mclose").onclick = () => { modal.remove(); hideSelBar(); };
    modal.addEventListener("click", e => { if (e.target === modal) { modal.remove(); hideSelBar(); } });

    // Tab switching
    let activeTabContent = outputTab;
    if (jsonTab) {
      document.getElementById("pl-tab-output").onclick = () => {
        activeTabContent = outputTab;
        document.getElementById("pl-rewritten-display").textContent = outputTab;
        document.getElementById("pl-tab-output").classList.add("pl-rtab-active");
        document.getElementById("pl-tab-json").classList.remove("pl-rtab-active");
      };
      document.getElementById("pl-tab-json").onclick = () => {
        activeTabContent = JSON.stringify(json_version, null, 2);
        document.getElementById("pl-rewritten-display").textContent = activeTabContent;
        document.getElementById("pl-tab-json").classList.add("pl-rtab-active");
        document.getElementById("pl-tab-output").classList.remove("pl-rtab-active");
      };
    }

    document.getElementById("pl-copy-btn").onclick = () => {
      navigator.clipboard.writeText(activeTabContent).then(() => {
        const btn = document.getElementById("pl-copy-btn");
        if (btn) btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      });
    };

    document.getElementById("pl-replace-btn").onclick = () => {
      updateLastRefineMeta({
        originalPrompt: originalText,
        refinedPrompt: activeTabContent,
        mode: "refine",
        appliedRules: []
      });
      replaceText(activeTabContent, savedRange, savedActiveEl, savedSelStart, savedSelEnd, originalText);
      modal.remove();
      showToast("✓ Replaced in page", "success");
    };

    const injectJsonBtn = document.getElementById("pl-inject-json-btn");
    if (injectJsonBtn) injectJsonBtn.onclick = () => {
      const jsonStr = JSON.stringify(json_version, null, 2);
      updateLastRefineMeta({
        originalPrompt: originalText,
        refinedPrompt: jsonStr,
        mode: "json",
        appliedRules: []
      });
      replaceText(jsonStr, savedRange, savedActiveEl, savedSelStart, savedSelEnd, originalText);
      modal.remove();
      showToast("{ } JSON injected", "success");
    };
  }

  // ── Feedback Modal ────────────────────────────────────────────────────────
  function showFeedbackModal() {
    document.getElementById("pl-feedback-modal")?.remove();
    const modal = document.createElement("div");
    modal.id = "pl-feedback-modal";
    modal.className = "pl-feedback-wrap";
    modal.innerHTML = `
      <div class="pl-feedback-card">
        <div class="pl-fb-hdr"><span>Share Feedback</span><button id="pl-fb-x">✕</button></div>
        <div class="pl-stars" id="pl-stars">
          ${[1,2,3,4,5].map(n => `<button class="pl-star" data-r="${n}">★</button>`).join("")}
        </div>
        <textarea class="pl-fb-area" id="pl-fb-area" placeholder="What worked? What could be better?"></textarea>
        <button class="pl-fb-submit" id="pl-fb-submit">Submit Feedback</button>
      </div>`;
    document.body.appendChild(modal);
    let rating = 0;
    modal.querySelectorAll(".pl-star").forEach(s => {
      s.onclick = () => {
        rating = parseInt(s.dataset.r);
        modal.querySelectorAll(".pl-star").forEach(st => st.classList.toggle("active", parseInt(st.dataset.r) <= rating));
      };
    });
    document.getElementById("pl-fb-x").onclick = () => modal.remove();
    document.getElementById("pl-fb-submit").onclick = () => {
      const text = document.getElementById("pl-fb-area").value.trim();
      if (!text && !rating) return;
      const feedback = buildFeedbackPayload(rating);
      if (text) feedback.comment = text;
      // Save locally
      chrome.storage.local.get({ plFeedback: [] }, ({ plFeedback }) => {
        plFeedback.push(feedback);
        chrome.storage.local.set({ plFeedback });
      });
      // Save to Firestore via background (requires login)
      chrome.runtime.sendMessage({ type: "SAVE_FEEDBACK", feedback });
      modal.remove();
      showToast("✓ Thank you for your feedback!", "success");
    };
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg, type = "info", actionLabel = null, actionFn = null) {
    document.querySelector(".pl-toast")?.remove();
    const t = document.createElement("div");
    t.className = `pl-toast pl-toast-${type}`;
    t.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button class="pl-toast-act">${esc(actionLabel)}</button>` : ""}`;
    document.body.appendChild(t);
    if (actionLabel && actionFn) t.querySelector(".pl-toast-act").onclick = () => { actionFn(); t.remove(); };
    requestAnimationFrame(() => t.classList.add("pl-toast-in"));
    setTimeout(() => { t.classList.remove("pl-toast-in"); setTimeout(() => t.remove(), 300); }, 4500);
  }

  function showNoKeyToast() { showToast("Add your Groq API key in the extension popup", "error"); }

  // ── Provider Call (Groq/Gemini auto-detected in background) ─────────────────────────────────────────────────────────────
  function callProviderAI(mode, text, apiKey, preference) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "GEMINI_REQUEST", mode, text, apiKey, preference }, res => {
        resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (res || { error: "No response" }));
      });
    });
  }

  // ── Message Listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROMPTLENS_ARM_SELECTION") {
      selectionActivationArmed = true;
      captureSelection();
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 2) positionSelBar();
    }
    if (msg.type === "GET_TEXT") return window.getSelection().toString();
    if (msg.type === "APPLY_MODIFY") {
      let insertText = msg.text;
      if (msg.mode === "json") {
        try { insertText = JSON.stringify(JSON.parse(msg.text), null, 2); } catch (_) {}
      }
      updateLastRefineMeta({
        originalPrompt: savedText,
        refinedPrompt: insertText,
        mode: msg.mode || "refine",
        appliedRules: msg.appliedRules || []
      });
      replaceText(insertText, savedRange, savedActiveEl, savedSelStart, savedSelEnd, savedText);
      showToast(msg.mode === "json" ? "{ } JSON injected" : "✓ Prompt refined", "success",
        "Undo", () => replaceText(savedText, savedRange, savedActiveEl, savedSelStart, savedSelStart + insertText.length, insertText));
    }
    if (msg.type === "SHOW_EXPLAIN") showExplainModal(msg.original, msg.result);
    if (msg.type === "SHOW_FEEDBACK") showFeedbackModal();
    if (msg.type === "SHOW_LOADING") showToast(`⏳ ${msg.mode === "json" ? "Structuring" : msg.mode === "explain" ? "Analyzing" : "Refining"} with PromptLens…`, "info");
    if (msg.type === "SHOW_ERROR") showToast("⚠ " + msg.error, "error");
  });

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

})();

