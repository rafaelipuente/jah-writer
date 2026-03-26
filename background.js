// background.js — JAH Writer Service Worker

importScripts("modes.js");

const VALID_MODE_IDS = new Set(JAH_MODES.map(m => m.id));
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_TEXT = 2000;

// Throttle: enforce minimum gap between requests per provider to stay under rate limits.
// Gemini free tier = 15 RPM, OpenAI tier-1 = 500 RPM.
const MIN_GAP_MS = { gemini: 4500, openai: 200 };
const lastCallTime = { gemini: 0, openai: 0 };

async function throttle(provider) {
  const gap = MIN_GAP_MS[provider] || 4500;
  const elapsed = Date.now() - lastCallTime[provider];
  if (elapsed < gap) await new Promise(r => setTimeout(r, gap - elapsed));
  lastCallTime[provider] = Date.now();
}

chrome.runtime.onInstalled.addListener(() => {
  // Migrate old single-key storage to new dual-key format.
  chrome.storage.sync.get(["geminiApiKey", "jahGeminiKey"], d => {
    if (d.geminiApiKey && !d.jahGeminiKey) {
      chrome.storage.sync.set({ jahGeminiKey: d.geminiApiKey, jahProvider: "gemini" }, () => {
        chrome.storage.sync.remove("geminiApiKey");
      });
    }
  });

  chrome.contextMenus.removeAll(() => {
    JAH_MODES.forEach(m =>
      chrome.contextMenus.create({
        id: "jah-" + m.id,
        title: "JAH Writer: " + m.label,
        contexts: ["selection"],
      })
    );
    chrome.contextMenus.create({
      id: "jah-search",
      title: "JAH Writer: Search",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.menuItemId.startsWith("jah-") || !info.selectionText) return;

  if (info.menuItemId === "jah-search") {
    chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(info.selectionText) });
    return;
  }

  if (!tab?.id) return;
  const mode = info.menuItemId.replace("jah-", "");
  if (!VALID_MODE_IDS.has(mode)) return;
  chrome.storage.local.set({ jahLastMode: mode });
  chrome.tabs.sendMessage(tab.id, {
    action: "transformFromContext",
    mode,
    text: info.selectionText,
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "trigger-jah") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "triggerJah" });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((req, sender, res) => {
  if (req.action === "callAI") {
    // Keep the service worker alive during long API calls.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    callAI(req?.text, req?.mode)
      .then(r => { clearInterval(keepAlive); res({ success: true, result: r }); })
      .catch(e => { clearInterval(keepAlive); res({ success: false, error: e.message || "Unknown error" }); });
    return true;
  }
  if (req.action === "getApiKey") {
    chrome.storage.sync.get(["jahProvider", "jahGeminiKey", "jahOpenaiKey"], d => {
      res({ provider: d.jahProvider || "gemini", geminiKey: d.jahGeminiKey || "", openaiKey: d.jahOpenaiKey || "" });
    });
    return true;
  }
  if (req.action === "setApiKey") {
    const updates = {};
    if (req.provider) updates.jahProvider = req.provider;
    if (typeof req.geminiKey === "string" && req.geminiKey) updates.jahGeminiKey = req.geminiKey;
    if (typeof req.openaiKey === "string" && req.openaiKey) updates.jahOpenaiKey = req.openaiKey;
    chrome.storage.sync.set(updates, () => res({ success: true }));
    return true;
  }
  if (req.action === "getLastMode") {
    chrome.storage.local.get(["jahLastMode"], d => res({ mode: d.jahLastMode || "proofread" }));
    return true;
  }
  if (req.action === "setLastMode") {
    const mode = VALID_MODE_IDS.has(req.mode) ? req.mode : "proofread";
    chrome.storage.local.set({ jahLastMode: mode }, () => res({ success: true }));
    return true;
  }
  if (req.action === "getBlocklist") {
    chrome.storage.sync.get(["jahBlocklist"], d => res({ blocklist: d.jahBlocklist || [] }));
    return true;
  }
  if (req.action === "updateBlocklist") {
    chrome.storage.sync.set({ jahBlocklist: req.blocklist }, () => res({ success: true }));
    return true;
  }
  if (req.action === "getHistory") {
    chrome.storage.local.get(["jahHistory"], d => res({ history: d.jahHistory || [] }));
    return true;
  }
  if (req.action === "addHistory") {
    chrome.storage.local.get(["jahHistory"], d => {
      const list = d.jahHistory || [];
      const mode = VALID_MODE_IDS.has(req?.mode) ? req.mode : "proofread";
      const input = String(req?.input || "").slice(0, MAX_HISTORY_TEXT);
      const output = String(req?.output || "").slice(0, MAX_HISTORY_TEXT);
      list.unshift({ mode, input, output, ts: Date.now() });
      if (list.length > MAX_HISTORY_ITEMS) list.length = MAX_HISTORY_ITEMS;
      chrome.storage.local.set({ jahHistory: list }, () => res({ success: true }));
    });
    return true;
  }
});

function buildPrompt(text, mode) {
  const p = {
    proofread:  `You are a meticulous proofreader. Fix all grammar, spelling, punctuation, and syntax errors. Preserve the original tone and meaning. Return ONLY the corrected text.\n\nText: "${text}"`,
    spellcheck: `You are a spell checker. Fix ONLY spelling mistakes. Do not change grammar, punctuation, word order, tone, or sentence structure — even if you think they could be improved. If a word is spelled correctly, leave it exactly as written. Return ONLY the corrected text.\n\nText: "${text}"`,
    professional: `Rewrite in a polished, professional tone for business communication. Clear, confident language. Return ONLY the rewritten text.\n\nText: "${text}"`,
    casual: `Rewrite in a relaxed, conversational tone like talking to a friend. Natural and approachable. Return ONLY the rewritten text.\n\nText: "${text}"`,
    social: `Rewrite for social media — engaging, punchy, attention-grabbing. Concise and shareable. Return ONLY the rewritten text.\n\nText: "${text}"`,
    concise: `Make this significantly more concise. Remove unnecessary words, redundancy, filler. Sharp and clear. Return ONLY the rewritten text.\n\nText: "${text}"`,
    elaborate: `Expand and elaborate. Add detail, context, depth while maintaining the original meaning. Richer and more informative. Return ONLY the rewritten text.\n\nText: "${text}"`,
    friendly: `Rewrite in a warm, friendly, approachable tone. Add positivity while keeping the message clear. Return ONLY the rewritten text.\n\nText: "${text}"`,
    academic: `Rewrite in formal academic style. Precise, scholarly language with proper structure. Objective and clear. Return ONLY the rewritten text.\n\nText: "${text}"`,
    debate: `You are an expert debate coach and master rhetorician. Rewrite this to sound significantly more intelligent, articulate, and devastating in a debate setting. Strengthen logical structure. Add supporting reasoning, evidence-based language, and rhetorical techniques (ethos, pathos, logos). Eliminate weak phrasing, logical fallacies, and vague claims. Make every point sound valid, well-researched, and impossible to argue against. Keep the original position but elevate it to sound like it comes from the sharpest mind in the room. Return ONLY the rewritten text.\n\nText: "${text}"`,
    factcheck: `You are a rigorous fact-checker. Analyze the following text for factual accuracy.

For each claim in the text:
1. State the claim.
2. Evaluate whether it is TRUE, FALSE, PARTIALLY TRUE, or UNVERIFIABLE.
3. Provide a brief explanation with reasoning.

End with an overall VERDICT line: one of TRUE, FALSE, MOSTLY TRUE, MOSTLY FALSE, MIXED, or UNVERIFIABLE.

Format your response exactly like this:
CLAIM: [the claim]
RATING: [TRUE/FALSE/PARTIALLY TRUE/UNVERIFIABLE]
EXPLANATION: [brief reasoning]

(repeat for each claim)

VERDICT: [overall rating]

Text: "${text}"`,
    summarize: `Summarize the following text concisely. Capture the key points and main ideas in a clear, readable format. Keep it brief but complete. Return ONLY the summary.\n\nText: "${text}"`,
    rewrite: `Rewrite the following text from scratch. Keep the same meaning and key information, but use completely different wording and sentence structure. Make it clear and well-written. Return ONLY the rewritten text.\n\nText: "${text}"`,
    simplify: `Rewrite this text so it is extremely clear and simple. Use short sentences, plain everyday words, and straightforward structure. Avoid jargon, complex vocabulary, and convoluted phrasing. Anyone should be able to understand it easily. Return ONLY the simplified text.\n\nText: "${text}"`,
    formal: `Rewrite this text in a formal, polite, and respectful tone. Use courteous language appropriate for official correspondence, customer communication, or professional emails. Be diplomatic and tactful. Return ONLY the rewritten text.\n\nText: "${text}"`,
    technical: `Rewrite this text in a precise technical style suitable for documentation, README files, bug reports, or technical discussions. Use clear, unambiguous language. Be specific and structured. Avoid fluff and unnecessary words. Return ONLY the rewritten text.\n\nText: "${text}"`,
  };
  return p[mode] || p.proofread;
}

const MAX_SERVER_RETRIES = 2;

async function callAI(text, mode) {
  const safeText = String(text || "").trim();
  if (!safeText) throw new Error("No text provided.");

  const data = await chrome.storage.sync.get(["jahProvider", "jahGeminiKey", "jahOpenaiKey"]);
  const provider = data.jahProvider || "gemini";
  const safeMode = VALID_MODE_IDS.has(mode) ? mode : "proofread";
  const prompt = buildPrompt(safeText, safeMode);

  const alt = provider === "openai" ? "gemini" : "openai";
  const keys = { gemini: data.jahGeminiKey, openai: data.jahOpenaiKey };
  const callers = { gemini: callGemini, openai: callOpenAI };

  if (!keys[provider]) throw new Error(`No ${provider === "openai" ? "OpenAI" : "Gemini"} API key configured. Open JAH Writer settings to add one.`);

  try {
    await throttle(provider);
    return await callers[provider](keys[provider], prompt);
  } catch (primaryErr) {
    // Auto-failover: if the primary hit a rate limit and the other provider has a key, try it.
    if (primaryErr._rateLimit && keys[alt]) {
      try {
        await throttle(alt);
        return await callers[alt](keys[alt], prompt);
      } catch (fallbackErr) {
        throw primaryErr;
      }
    }
    throw primaryErr;
  }
}

async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });

  let lastError;
  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));

    let resp;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
    } catch (e) {
      clearTimeout(timeoutId);
      lastError = new Error(e?.name === "AbortError" ? "Request timed out. Try again." : "Network error. Check your connection.");
      continue;
    }
    clearTimeout(timeoutId);

    if (resp.status === 429) {
      if (attempt < MAX_SERVER_RETRIES) {
        const retrySecs = Number(resp.headers.get("Retry-After"));
        const wait = Number.isFinite(retrySecs) && retrySecs > 0 ? retrySecs : 5;
        await new Promise(r => setTimeout(r, Math.min(wait, 10) * 1000));
        continue;
      }
      const err = new Error("Gemini rate limit hit. Wait a moment or switch to OpenAI in settings.");
      err._rateLimit = true;
      throw err;
    }
    if (resp.status >= 500) {
      const err = await resp.json().catch(() => ({}));
      lastError = new Error(err?.error?.message || `Gemini server error (${resp.status})`);
      continue;
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Gemini API error (${resp.status})`);
    }

    const result = await resp.json();
    const out = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!out) throw new Error("Empty response from Gemini. Try again.");
    return out.trim();
  }
  throw lastError;
}

async function callOpenAI(apiKey, prompt) {
  const url = "https://api.openai.com/v1/chat/completions";
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 2048,
  });

  let lastError;
  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));

    let resp;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeoutId);
      lastError = new Error(e?.name === "AbortError" ? "Request timed out. Try again." : "Network error. Check your connection.");
      continue;
    }
    clearTimeout(timeoutId);

    if (resp.status === 429) {
      if (attempt < MAX_SERVER_RETRIES) {
        const retrySecs = Number(resp.headers.get("Retry-After"));
        const wait = Number.isFinite(retrySecs) && retrySecs > 0 ? retrySecs : 3;
        await new Promise(r => setTimeout(r, Math.min(wait, 10) * 1000));
        continue;
      }
      const err = new Error("OpenAI rate limit hit. Wait a moment or switch to Gemini in settings.");
      err._rateLimit = true;
      throw err;
    }
    if (resp.status === 401) {
      throw new Error("OpenAI API key is invalid. Check your key in settings.");
    }
    if (resp.status >= 500) {
      const err = await resp.json().catch(() => ({}));
      lastError = new Error(err?.error?.message || `OpenAI server error (${resp.status})`);
      continue;
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI API error (${resp.status})`);
    }

    const result = await resp.json();
    const out = result?.choices?.[0]?.message?.content;
    if (!out) throw new Error("Empty response from OpenAI. Try again.");
    return out.trim();
  }
  throw lastError;
}
