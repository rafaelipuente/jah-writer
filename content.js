// content.js — JAH Writer Content Script

(() => {
  const modes = JAH_MODES;
  const validModeIds = new Set(modes.map(m => m.id));
  let toolbar = null;
  let resultPanel = null;
  let selectedText = "";
  let originalText = "";
  let activeElement = null;
  let selectionRange = null;
  let contextMenuTriggered = false;
  let lastMode = "proofread";
  let blocked = false;

  // Badge state
  let badge = null;
  let badgeTarget = null;
  let badgePicker = null;
  let badgeRepositionRAF = null;

  // Undo state
  let undoToast = null;
  let undoTimer = null;
  let undoData = null;

  // ── Blocklist gate ──
  chrome.runtime.sendMessage({ action: "getBlocklist" }, (r) => {
    if (chrome.runtime.lastError) {
      init();
      return;
    }
    const list = r?.blocklist || [];
    if (list.includes(location.hostname)) {
      blocked = true;
      return;
    }
    init();
  });

  // ── Load last mode ──
  chrome.runtime.sendMessage({ action: "getLastMode" }, (r) => {
    if (chrome.runtime.lastError) return;
    if (r?.mode && validModeIds.has(r.mode)) lastMode = r.mode;
  });

  function init() {
    // Context menu / keyboard shortcut trigger
    chrome.runtime.onMessage.addListener((msg) => {
      if (blocked) return;
      if (msg.action === "transformFromContext") {
        selectedText = msg.text;
        captureActive();
        contextMenuTriggered = true;
        processText(msg.mode);
      }
      if (msg.action === "triggerJah") {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (text && text.length > 1) {
          selectedText = text;
          captureActive();
          if (sel.rangeCount > 0) selectionRange = sel.getRangeAt(0).cloneRange();
          contextMenuTriggered = false;
          // Show the toolbar so the user can choose a mode
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          showToolbar(rect.left + rect.width / 2, rect.top);
        }
      }
    });

    // Text selection toolbar
    document.addEventListener("mouseup", (e) => {
      if (e.target.closest(".jah-bar") || e.target.closest(".jah-panel") || e.target.closest(".jah-badge") || e.target.closest(".jah-badge-picker")) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (text && text.length > 1) {
          selectedText = text;
          captureActive();
          if (sel.rangeCount > 0) selectionRange = sel.getRangeAt(0).cloneRange();
          showToolbar(e.clientX, e.clientY);
        } else {
          hideToolbar();
        }
      }, 10);
    });

    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest(".jah-bar") && !e.target.closest(".jah-panel") && !e.target.closest(".jah-toast")) {
        hideToolbar();
        hidePanel();
      }
      if (!e.target.closest(".jah-badge") && !e.target.closest(".jah-badge-picker")) {
        hideBadgePicker();
      }
    });

    // Field badge
    document.addEventListener("focusin", onFieldFocus);
    document.addEventListener("focusout", onFieldBlur);
  }

  function captureActive() {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) {
      activeElement = el;
    }
  }

  function saveLastMode(mode) {
    const safeMode = validModeIds.has(mode) ? mode : "proofread";
    lastMode = safeMode;
    chrome.runtime.sendMessage({ action: "setLastMode", mode: safeMode });
  }

  // ── Floating Toolbar ──
  function showToolbar(x, y) {
    hideToolbar();
    toolbar = document.createElement("div");
    toolbar.className = "jah-bar";

    const brand = document.createElement("div");
    brand.className = "jah-bar-brand";
    brand.textContent = "JAH Writer";
    toolbar.appendChild(brand);

    const row = document.createElement("div");
    row.className = "jah-bar-row";
    modes.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "jah-btn";
      if (m.id === lastMode) btn.classList.add("jah-btn-last");
      btn.innerHTML = `<span class="jah-btn-ico">${jahIcon(m.id)}</span><span class="jah-btn-txt">${m.label}</span>`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextMenuTriggered = false;
        saveLastMode(m.id);
        processText(m.id);
      });
      row.appendChild(btn);
    });

    // Search button
    const searchBtn = document.createElement("button");
    searchBtn.className = "jah-btn jah-btn-search";
    searchBtn.innerHTML = `<span class="jah-btn-ico">${jahIcon("search")}</span><span class="jah-btn-txt">Search</span>`;
    searchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (selectedText) {
        window.open("https://www.google.com/search?q=" + encodeURIComponent(selectedText), "_blank");
        hideToolbar();
      }
    });
    row.appendChild(searchBtn);

    toolbar.appendChild(row);
    document.body.appendChild(toolbar);

    const rect = toolbar.getBoundingClientRect();
    let px = x - rect.width / 2;
    let py = y - rect.height - 14;
    px = Math.max(8, Math.min(px, window.innerWidth - rect.width - 8));
    if (py < 8) py = y + 22;
    toolbar.style.left = px + "px";
    toolbar.style.top = py + window.scrollY + "px";
    toolbar.style.position = "absolute";
    requestAnimationFrame(() => toolbar.classList.add("jah-show"));
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  // ── Field Badge ──
  function onFieldFocus(e) {
    const el = e.target;
    if (!isEditable(el)) return;
    if (el.closest(".jah-bar") || el.closest(".jah-panel")) return;
    showBadge(el);
  }

  function onFieldBlur(e) {
    setTimeout(() => {
      if (badgePicker) return; // Picker is open — keep badge alive until user picks or dismisses
      const active = document.activeElement;
      if (badge && !badge.contains(active)) {
        hideBadge();
      }
    }, 150);
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT" && (!el.type || el.type === "text" || el.type === "search" || el.type === "url" || el.type === "email")) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function showBadge(el) {
    if (badgeTarget === el && badge) return;
    hideBadge();
    badgeTarget = el;

    badge = document.createElement("div");
    badge.className = "jah-badge";
    // Inline SVG avoids chrome-extension:// URL blocking on strict-CSP sites (e.g. Gmail)
    badge.innerHTML = `<svg width="16" height="16" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="JAH Writer">
      <path d="M5.5 2H12.5L13.5 6H4.5Z" fill="#E95420"/>
      <path d="M4.5 6L9 16L13.5 6Z" fill="#E95420"/>
      <line x1="9" y1="10" x2="9" y2="15.5" stroke="#1e1e1e" stroke-width="1" stroke-linecap="round"/>
      <line x1="6.2" y1="7" x2="7.5" y2="11" stroke="rgba(255,255,255,0.2)" stroke-width="0.8" stroke-linecap="round"/>
    </svg>`;
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleBadgePicker();
    });
    document.body.appendChild(badge);
    positionBadge();

    if (typeof ResizeObserver !== "undefined") {
      badge._resObs = new ResizeObserver(positionBadge);
      badge._resObs.observe(el);
    }
    window.addEventListener("scroll", positionBadge, true);
    window.addEventListener("resize", positionBadge);
  }

  function positionBadge() {
    if (!badge || !badgeTarget) return;
    cancelAnimationFrame(badgeRepositionRAF);
    badgeRepositionRAF = requestAnimationFrame(() => {
      if (!badge || !badgeTarget) return;
      const r = badgeTarget.getBoundingClientRect();
      badge.style.top = (r.bottom + window.scrollY - 28) + "px";
      badge.style.left = (r.right - 32) + "px";
    });
  }

  function hideBadge() {
    if (badge) {
      if (badge._resObs) badge._resObs.disconnect();
      window.removeEventListener("scroll", positionBadge, true);
      window.removeEventListener("resize", positionBadge);
      badge.remove();
      badge = null;
    }
    hideBadgePicker();
    badgeTarget = null;
  }

  function toggleBadgePicker() {
    if (badgePicker) { hideBadgePicker(); return; }
    if (!badge) return;

    badgePicker = document.createElement("div");
    badgePicker.className = "jah-badge-picker";
    modes.forEach((m) => {
      const btn = document.createElement("button");
      btn.className = "jah-badge-btn";
      if (m.id === lastMode) btn.classList.add("jah-btn-last");
      btn.innerHTML = `<span class="jah-btn-ico">${jahIcon(m.id)}</span><span>${m.label}</span>`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideBadgePicker();
        const el = badgeTarget;
        if (el) {
          const sel = window.getSelection();
          const selText = sel?.toString().trim();
          if (selText && selText.length > 1) {
            selectedText = selText;
            if (sel.rangeCount > 0) selectionRange = sel.getRangeAt(0).cloneRange();
          } else {
            selectedText = el.value !== undefined ? el.value : el.textContent;
            selectionRange = null;
          }
          activeElement = el;
          contextMenuTriggered = false;
          saveLastMode(m.id);
          processText(m.id);
        }
      });
      badgePicker.appendChild(btn);
    });

    // Search button in badge picker
    const searchBtn = document.createElement("button");
    searchBtn.className = "jah-badge-btn jah-badge-btn-search";
    searchBtn.innerHTML = `<span class="jah-btn-ico">${jahIcon("search")}</span><span>Search</span>`;
    searchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideBadgePicker();
      const el = badgeTarget;
      if (el) {
        const sel = window.getSelection();
        const selText = sel?.toString().trim();
        const query = (selText && selText.length > 1) ? selText : (el.value !== undefined ? el.value : el.textContent);
        if (query && query.trim()) {
          window.open("https://www.google.com/search?q=" + encodeURIComponent(query.trim()), "_blank");
        }
      }
    });
    badgePicker.appendChild(searchBtn);

    document.body.appendChild(badgePicker);

    const bRect = badge.getBoundingClientRect();
    badgePicker.style.top = (bRect.top + window.scrollY - badgePicker.offsetHeight - 4) + "px";
    badgePicker.style.left = (bRect.right - badgePicker.offsetWidth) + "px";
    requestAnimationFrame(() => badgePicker.classList.add("jah-show"));
  }

  function hideBadgePicker() {
    if (badgePicker) { badgePicker.remove(); badgePicker = null; }
  }

  // ── Process ──
  async function processText(mode) {
    const safeMode = validModeIds.has(mode) ? mode : "proofread";
    if (!selectedText?.trim()) {
      showPanel("err", "No text selected.");
      return;
    }
    hideToolbar();
    originalText = selectedText;
    showPanel("loading");
    try {
      const r = await chrome.runtime.sendMessage({ action: "callAI", text: selectedText, mode: safeMode });
      if (r?.success && typeof r.result === "string") {
        showPanel("done", r.result, safeMode);
      } else {
        showPanel("err", r?.error || "Transformation failed.");
      }
    } catch (e) {
      showPanel("err", e.message || "Connection failed.");
    }
  }

  // ── Diff ──
  function diffWords(a, b) {
    const wa = a.split(/(\s+)/);
    const wb = b.split(/(\s+)/);
    const m = wa.length, n = wb.length;
    const max = m + n;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    v.fill(-1);
    v[max + 1] = 0;

    for (let d = 0; d <= max; d++) {
      trace.push(new Int32Array(v));
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
          x = v[max + k + 1];
        } else {
          x = v[max + k - 1] + 1;
        }
        let y = x - k;
        while (x < m && y < n && wa[x] === wb[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= m && y >= n) {
          return buildDiff(trace, wa, wb, max);
        }
      }
    }
    return buildDiff(trace, wa, wb, max);
  }

  function buildDiff(trace, wa, wb, max) {
    let x = wa.length, y = wb.length;
    const ops = [];
    for (let d = trace.length - 1; d > 0; d--) {
      const v = trace[d - 1];
      const k = x - y;
      let prevK;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = v[max + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        ops.unshift({ type: "eq", text: wa[--x] });
        y--;
      }
      if (d > 0) {
        if (x === prevX) {
          ops.unshift({ type: "ins", text: wb[--y] });
        } else {
          ops.unshift({ type: "del", text: wa[--x] });
        }
      }
    }
    while (x > 0 && y > 0) {
      ops.unshift({ type: "eq", text: wa[--x] });
      y--;
    }
    return ops;
  }

  function renderDiff(original, result) {
    const ops = diffWords(original, result);
    return ops.map(op => {
      const t = esc(op.text);
      if (op.type === "del") return `<span class="jah-diff-del">${t}</span>`;
      if (op.type === "ins") return `<span class="jah-diff-ins">${t}</span>`;
      return t;
    }).join("");
  }

  // ── Fact Check rendering ──
  function renderFactCheck(text) {
    const lines = text.split("\n");
    let html = "";
    let inClaim = false;
    let claimBuf = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const verdictMatch = trimmed.match(/^VERDICT:\s*(.+)/i);
      if (verdictMatch) {
        if (inClaim) { html += claimBuf + "</div>"; inClaim = false; }
        const v = verdictMatch[1].trim().toUpperCase();
        const cls = v.includes("TRUE") && !v.includes("FALSE") ? "jah-fc-true"
                  : v.includes("FALSE") && !v.includes("TRUE") ? "jah-fc-false"
                  : "jah-fc-mixed";
        html += `<div class="jah-fc-verdict"><span class="jah-fc-verdict-label">VERDICT</span><span class="jah-fc-badge ${cls}">${esc(v)}</span></div>`;
        continue;
      }

      const claimMatch = trimmed.match(/^CLAIM:\s*(.+)/i);
      if (claimMatch) {
        if (inClaim) html += claimBuf + "</div>";
        claimBuf = `<div class="jah-fc-claim"><div class="jah-fc-claim-text">${esc(claimMatch[1])}</div>`;
        inClaim = true;
        continue;
      }

      const ratingMatch = trimmed.match(/^RATING:\s*(.+)/i);
      if (ratingMatch && inClaim) {
        const r = ratingMatch[1].trim().toUpperCase();
        const cls = r === "TRUE" ? "jah-fc-true"
                  : r === "FALSE" ? "jah-fc-false"
                  : "jah-fc-mixed";
        claimBuf += `<span class="jah-fc-badge ${cls}">${esc(r)}</span>`;
        continue;
      }

      const expMatch = trimmed.match(/^EXPLANATION:\s*(.+)/i);
      if (expMatch && inClaim) {
        claimBuf += `<div class="jah-fc-exp">${esc(expMatch[1])}</div>`;
        continue;
      }

      if (inClaim) {
        claimBuf += `<div class="jah-fc-exp">${esc(trimmed)}</div>`;
      } else {
        html += `<div class="jah-fc-line">${esc(trimmed)}</div>`;
      }
    }

    if (inClaim) html += claimBuf + "</div>";
    return html || `<div class="jah-fc-line">${esc(text)}</div>`;
  }

  // ── Result Panel ──
  function showPanel(state, content = "", mode = "") {
    hidePanel();
    resultPanel = document.createElement("div");
    resultPanel.className = "jah-panel";

    if (state === "loading") {
      resultPanel.innerHTML = `
        <div class="jah-panel-head">JAH Writer</div>
        <div class="jah-panel-loading"><div class="jah-spin"></div><span>Processing your text...</span></div>`;
    } else if (state === "err") {
      resultPanel.innerHTML = `
        <div class="jah-panel-head">JAH Writer</div>
        <div class="jah-panel-err">${esc(content)}</div>`;
    } else if (mode === "factcheck") {
      const m = modes.find(i => i.id === mode);
      resultPanel.innerHTML = `
        <div class="jah-panel-head">
          JAH Writer
          <span class="jah-panel-mode">${jahIcon(m.id)} ${m.label}</span>
        </div>
        <div class="jah-panel-body jah-fc-body">${renderFactCheck(content)}</div>
        <div class="jah-panel-actions">
          <button class="jah-act jah-act-copy" data-t="${escA(content)}">COPY</button>
          <button class="jah-act jah-act-close">&#x2715;</button>
        </div>`;
    } else {
      const m = modes.find(i => i.id === mode) || { id: "proofread", label: "Result" };
      const canReplace = !contextMenuTriggered || activeElement || selectionRange;
      const diffHtml = renderDiff(originalText, content);
      resultPanel.innerHTML = `
        <div class="jah-panel-head">
          JAH Writer
          <span class="jah-panel-mode">${jahIcon(m.id)} ${m.label}</span>
        </div>
        <div class="jah-panel-body" data-view="diff">${diffHtml}</div>
        <div class="jah-panel-actions">
          <button class="jah-act jah-act-copy" data-t="${escA(content)}">COPY</button>
          <button class="jah-act jah-act-replace${canReplace ? "" : " jah-act-disabled"}" data-t="${escA(content)}" ${canReplace ? "" : 'title="Cannot replace -- selection lost" disabled'}>REPLACE</button>
          <button class="jah-act jah-act-diff jah-act-active">DIFF</button>
          <button class="jah-act jah-act-plain">PLAIN</button>
          <button class="jah-act jah-act-close">&#x2715;</button>
        </div>`;

      resultPanel._plainHtml = esc(content);
      resultPanel._diffHtml = diffHtml;
    }

    document.body.appendChild(resultPanel);
    resultPanel.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);";
    requestAnimationFrame(() => resultPanel.classList.add("jah-show"));

    // Actions
    resultPanel.querySelector(".jah-act-copy")?.addEventListener("click", (e) => {
      navigator.clipboard.writeText(e.currentTarget.dataset.t).then(() => {
        e.currentTarget.textContent = "COPIED";
        setTimeout(() => e.currentTarget.textContent = "COPY", 1200);
      });
    });
    resultPanel.querySelector(".jah-act-replace")?.addEventListener("click", (e) => {
      const newText = e.currentTarget.dataset.t;
      captureUndoState();
      replaceText(newText);
      showUndoToast();
      e.currentTarget.textContent = "DONE";
      setTimeout(() => hidePanel(), 600);
    });
    resultPanel.querySelector(".jah-act-close")?.addEventListener("click", hidePanel);

    resultPanel.querySelector(".jah-act-diff")?.addEventListener("click", () => {
      const body = resultPanel.querySelector(".jah-panel-body");
      if (body) { body.innerHTML = resultPanel._diffHtml; body.dataset.view = "diff"; }
      resultPanel.querySelector(".jah-act-diff")?.classList.add("jah-act-active");
      resultPanel.querySelector(".jah-act-plain")?.classList.remove("jah-act-active");
    });
    resultPanel.querySelector(".jah-act-plain")?.addEventListener("click", () => {
      const body = resultPanel.querySelector(".jah-panel-body");
      if (body) { body.innerHTML = resultPanel._plainHtml; body.dataset.view = "plain"; }
      resultPanel.querySelector(".jah-act-plain")?.classList.add("jah-act-active");
      resultPanel.querySelector(".jah-act-diff")?.classList.remove("jah-act-active");
    });
  }

  function hidePanel() {
    if (resultPanel) { resultPanel.remove(); resultPanel = null; }
  }

  // ── Undo ──
  function captureUndoState() {
    if (!activeElement) { undoData = null; return; }
    if (activeElement.tagName === "TEXTAREA" || activeElement.tagName === "INPUT") {
      undoData = {
        el: activeElement,
        type: "value",
        value: activeElement.value,
        start: activeElement.selectionStart,
        end: activeElement.selectionEnd,
      };
    } else if (activeElement.isContentEditable) {
      undoData = {
        el: activeElement,
        type: "contentEditable",
        html: activeElement.innerHTML,
      };
    } else if (selectionRange) {
      undoData = { type: "range", text: originalText };
    } else {
      undoData = null;
    }
  }

  function showUndoToast() {
    hideUndoToast();
    if (!undoData) return;

    let seconds = 5;
    undoToast = document.createElement("div");
    undoToast.className = "jah-toast";
    undoToast.innerHTML = `<span>Replaced</span><button class="jah-toast-undo">Undo (${seconds}s)</button>`;
    document.body.appendChild(undoToast);
    requestAnimationFrame(() => undoToast.classList.add("jah-show"));

    const btn = undoToast.querySelector(".jah-toast-undo");
    btn.addEventListener("click", () => {
      performUndo();
      hideUndoToast();
    });

    undoTimer = setInterval(() => {
      seconds--;
      if (seconds <= 0) {
        hideUndoToast();
      } else if (btn) {
        btn.textContent = `Undo (${seconds}s)`;
      }
    }, 1000);
  }

  function hideUndoToast() {
    if (undoTimer) { clearInterval(undoTimer); undoTimer = null; }
    if (undoToast) { undoToast.remove(); undoToast = null; }
  }

  function performUndo() {
    if (!undoData) return;
    const d = undoData;
    undoData = null;

    if (d.type === "value" && d.el) {
      d.el.focus();
      d.el.value = d.value;
      d.el.setSelectionRange(d.start, d.end);
      d.el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (d.type === "contentEditable" && d.el) {
      d.el.focus();
      d.el.innerHTML = d.html;
      d.el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ── Replace ──
  function canReplaceFn() {
    return activeElement || selectionRange;
  }

  function replaceText(t) {
    if (!canReplaceFn()) return;

    if (activeElement && (activeElement.tagName === "TEXTAREA" || activeElement.tagName === "INPUT")) {
      const s = activeElement.selectionStart;
      const e = activeElement.selectionEnd;
      activeElement.focus();
      activeElement.setSelectionRange(s, e);
      if (!document.execCommand("insertText", false, t)) {
        activeElement.value = activeElement.value.substring(0, s) + t + activeElement.value.substring(e);
      }
      activeElement.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    if (selectionRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(selectionRange);
      if (!document.execCommand("insertText", false, t)) {
        selectionRange.deleteContents();
        selectionRange.insertNode(document.createTextNode(t));
      }
    }
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function escA(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
})();
