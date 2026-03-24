# JAH Writer -- AI Text Assistant

Chrome extension for improving your writing. Proofread, restyle, summarize, fact-check, and transform text with AI.

Works with **Google Gemini** and **OpenAI** -- pick your provider, paste your API key, and go.

Your data goes directly from your browser to the AI provider. No middleman. No servers. Private by design.

---

## Install (2 minutes)

1. **Download** -- Click the green **Code** button above, then **Download ZIP**
2. **Unzip** -- Extract the ZIP file to any folder on your computer
3. **Load in Chrome:**
   - Open Chrome and go to `chrome://extensions/`
   - Turn on **Developer mode** (toggle in the top right)
   - Click **Load unpacked**
   - Select the unzipped folder
4. **Add your API key:**
   - Click the JAH Writer icon in your Chrome toolbar (puzzle piece icon if it's hidden)
   - Click the status pill that says "Offline" to open settings
   - Choose **Gemini** or **OpenAI** as your provider
   - Paste your API key and click **Save**
5. **Get an API key** (if you don't have one):
   - **Gemini (free):** Go to [Google AI Studio](https://aistudio.google.com/apikey) -- sign in -- click "Create API key"
   - **OpenAI (paid):** Go to [OpenAI Platform](https://platform.openai.com/api-keys) -- sign in -- create a new key

That's it. Select any text on any webpage and the JAH Writer toolbar will appear.

---

## Features

- 15 writing modes + Google Search
- Inline floating toolbar on any webpage (select text to activate)
- Field badge on text inputs and textareas
- Right-click context menu integration
- Keyboard shortcut: `Ctrl+Shift+J` (`Cmd+Shift+J` on Mac)
- Side-by-side original vs improved comparison
- Word-level diff highlighting
- Fact checker with claim-by-claim verdicts
- Transformation history
- Per-site enable/disable blocklist
- Undo after replace (5 second window)
- Automatic rate limit handling with provider failover
- Dark, high-contrast UI

## Modes

| Mode | What it does |
|------|-------------|
| Proofread | Fix grammar, spelling, punctuation |
| Make Professional | Polished business tone |
| Casual | Relaxed, conversational |
| Social Media | Punchy, shareable |
| Shorten | Remove unnecessary words |
| Expand | Add detail and depth |
| Friendly | Warm and approachable |
| Academic | Formal, scholarly |
| Strong Argument | Logically airtight, impossible to argue against |
| Fact Check | Evaluate claims for factual accuracy with verdicts |
| Summarize | Condense to key points |
| Rewrite | Same meaning, fresh wording |
| Clear & Simple | Plain language anyone can understand |
| Formal / Polite | Courteous, respectful, diplomatic |
| Technical | Precise documentation / README style |
| **Search** | Open a Google search for the selected text |

## How to Use

**Inline:** Select text on any page -- JAH Writer toolbar appears -- click a mode -- Copy or Replace

**Right-click:** Select text -- right-click -- pick a JAH Writer mode from the context menu

**Popup:** Click the JAH Writer icon -- paste text -- pick a mode -- copy the result

**Search:** Select text -- click Search in the toolbar, badge picker, context menu, or popup

**Keyboard shortcut:** `Ctrl+Shift+J` (`Cmd+Shift+J` on Mac)

---

## Files

```
jah-writer/
├── manifest.json      Extension config (Manifest V3)
├── background.js      Service worker: API calls, storage, context menus
├── content.js         Content script: inline toolbar, badge, replace, diff
├── content.css        Content script styles
├── popup.html         Popup UI and styles
├── popup.js           Popup logic
├── modes.js           Mode definitions (single source of truth)
├── icons.js           SVG icon map
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Stack

- Chrome Extension Manifest V3
- Dual AI providers: Google Gemini (gemini-2.0-flash) / OpenAI (gpt-4o-mini)
- Vanilla JS -- zero dependencies, zero build step
- Client-side rate limiting with automatic provider failover

## Adding Modes

Add an entry to `modes.js`, an icon to `icons.js`, and a prompt to `background.js` `buildPrompt()`.

## Privacy

- API keys are stored in `chrome.storage.sync` (local to your browser, synced via your Google account if Chrome sync is on)
- Text is sent directly to the selected AI provider's API -- nothing else
- No analytics, no telemetry, no third-party servers

## License

MIT
