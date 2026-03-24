// popup.js — JAH Writer

const modes = JAH_MODES;
const validModeIds = new Set(modes.map(m => m.id));
const $ = id => document.getElementById(id);
let lastMode = "proofread";
let lastInput = "";
let lastOutput = "";
let currentProvider = "gemini";

document.addEventListener("DOMContentLoaded", () => {
  loadKey();
  loadLastMode();
  loadBlocklist();
  buildGrid();
  initWordCount();
  initSearch();
  initHistory();
  initTabs();
  initProvider();

  $("statusPill").addEventListener("click", () => {
    $("settings").classList.toggle("open");
    $("statusPill").classList.toggle("open");
  });

  $("siteEnabled").addEventListener("change", toggleCurrentSite);
});

// ── Provider Toggle ──
function initProvider() {
  $("provGemini").addEventListener("click", () => switchProvider("gemini"));
  $("provOpenai").addEventListener("click", () => switchProvider("openai"));
}

function switchProvider(prov) {
  currentProvider = prov;
  $("provGemini").classList.toggle("active", prov === "gemini");
  $("provOpenai").classList.toggle("active", prov === "openai");
  $("geminiKeySection").style.display = prov === "gemini" ? "" : "none";
  $("openaiKeySection").style.display = prov === "openai" ? "" : "none";
  updateStatus();
}

function updateStatus() {
  const hasKey = currentProvider === "openai"
    ? !!$("openaiKeyIn").value.trim()
    : !!$("geminiKeyIn").value.trim();
  setStatus(hasKey);
}

// ── API Key ──
function loadKey() {
  chrome.runtime.sendMessage({ action: "getApiKey" }, r => {
    if (chrome.runtime.lastError) { setStatus(false); return; }
    const prov = r?.provider || "gemini";
    currentProvider = prov;
    if (r?.geminiKey) $("geminiKeyIn").value = r.geminiKey;
    if (r?.openaiKey) $("openaiKeyIn").value = r.openaiKey;
    switchProvider(prov);
  });
}

$("saveBtn").addEventListener("click", () => {
  const geminiKey = $("geminiKeyIn").value.trim();
  const openaiKey = $("openaiKeyIn").value.trim();
  const activeKey = currentProvider === "openai" ? openaiKey : geminiKey;
  if (!activeKey) {
    const field = currentProvider === "openai" ? $("openaiKeyIn") : $("geminiKeyIn");
    field.style.borderColor = "var(--accent)";
    field.focus();
    setTimeout(() => field.style.borderColor = "", 1200);
    return;
  }

  const msg = { action: "setApiKey", provider: currentProvider };
  if (geminiKey) msg.geminiKey = geminiKey;
  if (openaiKey) msg.openaiKey = openaiKey;

  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      $("saveOk").textContent = "Failed to save";
      $("saveOk").classList.add("show");
      setTimeout(() => { $("saveOk").textContent = "Settings saved"; $("saveOk").classList.remove("show"); }, 2000);
      return;
    }
    $("saveOk").textContent = "Settings saved";
    $("saveOk").classList.add("show");
    setStatus(true);
    setTimeout(() => {
      $("saveOk").classList.remove("show");
      $("settings").classList.remove("open");
      $("statusPill").classList.remove("open");
    }, 1500);
  });
});

function setStatus(on) {
  $("dot").classList.toggle("on", on);
  $("stat").classList.toggle("on", on);
  $("stat").textContent = on ? "Ready" : "Offline";
  if (!on) {
    $("settings").classList.add("open");
    $("statusPill").classList.add("open");
  }
}

// ── Last Mode ──
function loadLastMode() {
  chrome.runtime.sendMessage({ action: "getLastMode" }, r => {
    if (chrome.runtime.lastError) return;
    if (r?.mode && validModeIds.has(r.mode)) {
      lastMode = r.mode;
      highlightLastMode();
    }
  });
}

function highlightLastMode() {
  document.querySelectorAll(".mode").forEach(btn => {
    btn.classList.toggle("mode-last", btn.dataset.mode === lastMode);
  });
}

// ── Mode Grid ──
function buildGrid() {
  $("modeGrid").innerHTML = "";
  modes.forEach(m => {
    const btn = document.createElement("button");
    btn.className = "mode";
    btn.dataset.mode = m.id;
    if (m.id === lastMode) btn.classList.add("mode-last");
    btn.innerHTML = `<span class="mode-ico">${jahIcon(m.id)}</span><span class="mode-lbl">${m.label}</span>`;
    btn.addEventListener("click", () => {
      lastMode = m.id;
      chrome.runtime.sendMessage({ action: "setLastMode", mode: m.id });
      highlightLastMode();
      run(m.id);
    });
    $("modeGrid").appendChild(btn);
  });
}

// ── Transform ──
async function run(mode) {
  const safeMode = validModeIds.has(mode) ? mode : "proofread";
  const text = $("compIn").value.trim();
  if (!text) {
    $("compIn").style.borderColor = "var(--accent)";
    $("compIn").focus();
    setTimeout(() => $("compIn").style.borderColor = "", 1200);
    return;
  }

  lastInput = text;
  $("outSect").classList.remove("on");
  $("loader").classList.add("on");

  let r;
  try {
    r = await chrome.runtime.sendMessage({ action: "callAI", text, mode: safeMode });
  } catch (e) {
    $("loader").classList.remove("on");
    lastOutput = "";
    $("outBox").textContent = "Error: " + (e.message || "Connection to background failed. Reload the extension.");
    $("outSect").classList.add("on");
    return;
  }

  $("loader").classList.remove("on");

  if (!r) {
    lastOutput = "";
    $("outBox").textContent = "Error: No response from background. Try reloading the extension (chrome://extensions).";
    $("outSect").classList.add("on");
    return;
  }

  if (r.success && typeof r.result === "string") {
    lastOutput = r.result;
    if (safeMode === "factcheck") {
      const html = renderPopupFactCheck(r.result);
      $("outBox").innerHTML = html || escHtml(r.result);
    } else {
      $("outBox").textContent = r.result;
    }
    $("outOriginal").textContent = text;
    $("outImproved").textContent = r.result;
    chrome.runtime.sendMessage({ action: "addHistory", mode: safeMode, input: text, output: r.result });
    loadHistory();
  } else {
    lastOutput = "";
    $("outBox").textContent = "Error: " + (r.error || "Transformation failed.");
  }
  $("outSect").classList.add("on");
  showTab("result");
}

// ── Output Tabs (Result / Compare) ──
function initTabs() {
  $("tabResult").addEventListener("click", () => showTab("result"));
  $("tabCompare").addEventListener("click", () => showTab("compare"));
}

function showTab(tab) {
  $("tabResult").classList.toggle("active", tab === "result");
  $("tabCompare").classList.toggle("active", tab === "compare");
  $("outResult").style.display = tab === "result" ? "" : "none";
  $("outCompare").style.display = tab === "compare" ? "" : "none";
}

// ── Fact Check rendering ──
function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function renderPopupFactCheck(text) {
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
      const cls = v.includes("TRUE") && !v.includes("FALSE") ? "fc-true"
                : v.includes("FALSE") && !v.includes("TRUE") ? "fc-false"
                : "fc-mixed";
      html += `<div class="fc-verdict"><span class="fc-verdict-label">VERDICT</span><span class="fc-badge ${cls}">${escHtml(v)}</span></div>`;
      continue;
    }

    const claimMatch = trimmed.match(/^CLAIM:\s*(.+)/i);
    if (claimMatch) {
      if (inClaim) html += claimBuf + "</div>";
      claimBuf = `<div class="fc-claim"><div class="fc-claim-text">${escHtml(claimMatch[1])}</div>`;
      inClaim = true;
      continue;
    }

    const ratingMatch = trimmed.match(/^RATING:\s*(.+)/i);
    if (ratingMatch && inClaim) {
      const r = ratingMatch[1].trim().toUpperCase();
      const cls = r === "TRUE" ? "fc-true" : r === "FALSE" ? "fc-false" : "fc-mixed";
      claimBuf += `<span class="fc-badge ${cls}">${escHtml(r)}</span>`;
      continue;
    }

    const expMatch = trimmed.match(/^EXPLANATION:\s*(.+)/i);
    if (expMatch && inClaim) {
      claimBuf += `<div class="fc-exp">${escHtml(expMatch[1])}</div>`;
      continue;
    }

    if (inClaim) {
      claimBuf += `<div class="fc-exp">${escHtml(trimmed)}</div>`;
    }
  }

  if (inClaim) html += claimBuf + "</div>";
  return html || `<div>${escHtml(text)}</div>`;
}

// ── Copy ──
$("copyOut").addEventListener("click", function () {
  const text = lastOutput || $("outBox").innerText || $("outBox").textContent;
  navigator.clipboard.writeText(text).then(() => {
    this.textContent = "Copied";
    setTimeout(() => this.textContent = "Copy Result", 1200);
  });
});

// ── Search ──
function initSearch() {
  $("searchIco").innerHTML = jahIcon("search");
  $("searchBtn").addEventListener("click", () => {
    const text = $("compIn").value.trim();
    if (text) {
      chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(text) });
    } else {
      $("compIn").style.borderColor = "rgba(96,165,250,0.5)";
      $("compIn").focus();
      setTimeout(() => $("compIn").style.borderColor = "", 1200);
    }
  });
}

// ── Word Count ──
function initWordCount() {
  $("compIn").addEventListener("input", updateWordCount);
  updateWordCount();
}

function updateWordCount() {
  const text = $("compIn").value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  $("wordCount").textContent = `${words} word${words !== 1 ? "s" : ""} / ${chars} character${chars !== 1 ? "s" : ""}`;
}

// ── History ──
function initHistory() {
  $("histToggle").addEventListener("click", () => {
    $("histToggle").classList.toggle("open");
    $("histList").classList.toggle("open");
  });
  loadHistory();
}

function loadHistory() {
  chrome.runtime.sendMessage({ action: "getHistory" }, r => {
    if (chrome.runtime.lastError) return;
    renderHistory(r?.history || []);
  });
}

function renderHistory(list) {
  const el = $("histList");
  el.innerHTML = "";
  if (!list.length) {
    el.innerHTML = '<div class="hist-empty">No recent transformations yet.</div>';
    return;
  }
  list.forEach(item => {
    const modeObj = modes.find(m => m.id === item.mode);
    const modeLabel = modeObj ? modeObj.label : item.mode;
    const ago = timeAgo(Number(item.ts) || Date.now());
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `<span class="hist-mode">${escHtml(modeLabel)}</span><span class="hist-preview">${escHtml(String(item.input || ""))}</span><span class="hist-time">${ago}</span>`;
    div.addEventListener("click", () => {
      $("compIn").value = String(item.input || "");
      updateWordCount();
    });
    el.appendChild(div);
  });
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

// ── Blocklist ──
function getCurrentHost() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.url) {
        try { resolve(new URL(tabs[0].url).hostname); } catch { resolve(""); }
      } else {
        resolve("");
      }
    });
  });
}

async function loadBlocklist() {
  const host = await getCurrentHost();
  $("siteHost").textContent = host || "---";

  chrome.runtime.sendMessage({ action: "getBlocklist" }, r => {
    if (chrome.runtime.lastError) return;
    const list = r?.blocklist || [];

    if (host) {
      const isBlocked = list.includes(host);
      $("siteEnabled").checked = !isBlocked;
    }

    renderBlockedList(list);
  });
}

function toggleCurrentSite() {
  const checked = $("siteEnabled").checked;
  getCurrentHost().then(host => {
    if (!host) return;
    chrome.runtime.sendMessage({ action: "getBlocklist" }, r => {
      if (chrome.runtime.lastError) return;
      let list = r?.blocklist || [];
      if (checked) {
        list = list.filter(h => h !== host);
      } else {
        if (!list.includes(host)) list.push(host);
      }
      chrome.runtime.sendMessage({ action: "updateBlocklist", blocklist: list }, () => {
        renderBlockedList(list);
      });
    });
  });
}

function renderBlockedList(list) {
  const el = $("blockedList");
  el.innerHTML = "";
  if (!list.length) return;
  list.forEach(host => {
    const item = document.createElement("div");
    item.className = "blocked-item";
    item.innerHTML = `<span>${host}</span><button class="blocked-remove" data-host="${host}">&times;</button>`;
    item.querySelector(".blocked-remove").addEventListener("click", () => removeBlocked(host));
    el.appendChild(item);
  });
}

function removeBlocked(host) {
  chrome.runtime.sendMessage({ action: "getBlocklist" }, r => {
    if (chrome.runtime.lastError) return;
    const list = (r?.blocklist || []).filter(h => h !== host);
    chrome.runtime.sendMessage({ action: "updateBlocklist", blocklist: list }, () => {
      renderBlockedList(list);
      getCurrentHost().then(current => {
        if (current === host) $("siteEnabled").checked = true;
      });
    });
  });
}
