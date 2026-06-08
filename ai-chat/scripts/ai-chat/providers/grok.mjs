import { sleep } from './shared.mjs';

const GROK_AUTH_ERROR_MESSAGE = '[grok] Browser session is not authenticated for X/Grok. Fresh, wrong, or logged-out Browser Tools profiles cannot use Grok. Start Browser Tools with the default or configured Chrome profile that is logged in to X/Grok, for example --profile Default --sync. If managed Chrome is using a stale copied profile, stop it with --clean, restart with the same profile plus --sync, and retry.';

function compactGrokUrl(url = '') {
  const text = String(url || '').trim();
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function isGrokLoginUrl(url = '') {
  const text = String(url || '').toLowerCase();
  if (!text) return false;
  if (/\/(i\/flow\/login|login|account\/login)\b/.test(text)) return true;
  return text.includes('redirect_after_login=%2fi%2fgrok') || text.includes('redirect_after_login=/i/grok');
}

function hasGrokAuthText(text = '') {
  const body = String(text || '');
  return /\b(Log in to X|Sign in to X|Sign in|Log in|Create account|Don't miss what's happening|Enter your phone number, email address, or username)\b/i.test(body);
}

export function classifyGrokPageState(snapshot = {}) {
  const url = String(snapshot.url || '');
  const title = String(snapshot.title || '');
  const bodyText = String(snapshot.bodyText || '');
  const combinedText = `${title}\n${bodyText}`;
  const hasUsableComposer = !!snapshot.hasComposer && !snapshot.composerDisabled;

  if (hasUsableComposer) {
    return { usable: true, status: 'ready', reason: 'Grok composer is available.', url };
  }

  if (isGrokLoginUrl(url) || snapshot.loginTextVisible || hasGrokAuthText(combinedText)) {
    return { usable: false, status: 'auth_required', reason: 'Browser session is not authenticated for X/Grok.', url };
  }

  const detail = snapshot.inspectError
    ? `Grok page could not be inspected: ${snapshot.inspectError}`
    : 'Grok composer is not available yet.';
  return { usable: false, status: 'not_ready', reason: detail, url };
}

function grokPreflightErrorMessage(state) {
  const currentPage = compactGrokUrl(state?.url);
  const suffix = currentPage ? ` Current page: ${currentPage}` : '';
  if (state?.status === 'auth_required') return `${GROK_AUTH_ERROR_MESSAGE}${suffix}`;
  return `[grok] Grok page is not usable before prompt submission. ${state?.reason || 'Composer was not found.'} Start Browser Tools with a Chrome profile that is logged in to X/Grok, for example --profile Default --sync, or stop stale managed Chrome with --clean and restart with the same profile plus --sync.${suffix}`;
}

async function inspectGrokPageState(page) {
  const fallbackUrl = page?.url?.() || '';
  try {
    return await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const title = document.title || '';
      const composer = document.querySelector('textarea[placeholder="Ask anything"]');
      const visibleControls = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .map(el => (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 200);
      const loginTextVisible = visibleControls.some(text => /^(Sign in|Log in|Create account)$/i.test(text)) || /\b(Log in to X|Sign in to X|Don't miss what's happening)\b/i.test(bodyText);
      return {
        url: location.href,
        title,
        bodyText,
        hasComposer: !!composer,
        composerDisabled: !!(composer?.disabled || composer?.readOnly || composer?.getAttribute('aria-disabled') === 'true'),
        loginTextVisible,
      };
    });
  } catch (error) {
    return {
      url: fallbackUrl,
      title: '',
      bodyText: '',
      hasComposer: false,
      composerDisabled: false,
      loginTextVisible: false,
      inspectError: error?.message || String(error),
    };
  }
}

export async function assertGrokPageUsable({ page, retries = 6, delayMs = 1000 } = {}) {
  let state = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const snapshot = await inspectGrokPageState(page);
    state = classifyGrokPageState(snapshot);
    if (state.usable) return state;
    if (state.status === 'auth_required') throw new Error(grokPreflightErrorMessage(state));
    if (attempt < retries - 1) await sleep(delayMs);
  }
  throw new Error(grokPreflightErrorMessage(state));
}

function isGrokQuotaMessage(text = '') {
  return /reached your limit of 15 Grok 4 questions/i.test(text) ||
    /Please sign up for Premium\+/i.test(text) ||
    /More Grok with Premium\+/i.test(text) ||
    /Upgrade to X Premium\+/i.test(text);
}

function isGrokUiFragmentLine(line = '') {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^(Thinking about your request|Planning parallel calls|Using both keyword and semantic searches)\.?$/i.test(t)) return true;
  if (/^Searching (the web|on X)$/i.test(t)) return true;
  if (/^\d+ results?$/i.test(t)) return true;
  if (/^\d+ more$/i.test(t)) return true;
  if (/^See new posts$/i.test(t)) return true;
  if (/^\d+ (web pages?|posts?)$/i.test(t)) return true;
  if (/^[\w.-]+\.(com|org|net|gov|io|co|edu)\s*(\+\d+)?$/i.test(t)) return true;
  if (/^(Ask anything|Dive deeper|Think Harder|Make summaries|Agents?|Fast|Expert|Auto)$/i.test(t)) return true;
  if (/^Explore\b/i.test(t) || /^1Password\b/i.test(t)) return true;
  if (/^(Factors|Compare|Explain|Show|What|How|Why|List|Summarize|Discuss|Break down|Analyze|Impact on|Examine|Explore|Investigate)\b/i.test(t) && t.length < 120) return true;
  return false;
}

function isGrokPlaceholderOnlyLine(line = '') {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^(Thinking about your request|Planning parallel calls|Using both keyword and semantic searches)\.?$/i.test(t)) return true;
  if (/^Searching (the web|on X)$/i.test(t)) return true;
  if (/^\d+ results?$/i.test(t)) return true;
  if (/^\d+ more$/i.test(t)) return true;
  if (/^See new posts$/i.test(t)) return true;
  if (/^\d+ (web pages?|posts?)$/i.test(t)) return true;
  if (/^[\w.-]+\.(com|org|net|gov|io|co|edu)\s*(\+\d+)?$/i.test(t)) return true;
  if (/^(Ask anything|Dive deeper|Think Harder|Make summaries|Agents?|Fast|Expert|Auto)$/i.test(t)) return true;
  if (/^Explore\b/i.test(t) || /^1Password\b/i.test(t)) return true;
  return false;
}

export function isGrokPlaceholderResponse(input = {}) {
  const { text = '', rawText = '' } = typeof input === 'string' ? { text: input } : input;
  const source = String(text || '').trim() || String(rawText || '').trim();
  if (!source) return false;
  const lines = source.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  return lines.every(isGrokPlaceholderOnlyLine);
}

function getGrokFallbackModels(requestedModel) {
  const normalized = (requestedModel || 'default').toLowerCase();
  if (normalized === 'expert' || normalized === 'think') return ['auto', 'fast'];
  if (normalized === 'default' || normalized === 'auto') return ['fast'];
  return [];
}

export function cleanRecoveredGrokText(text = '', prompt = '') {
  const cleanLines = text.split('\n').filter(line => {
    const t = line.trim();
    if (t.length === 0) return true;
    if (isGrokUiFragmentLine(t)) return false;
    if (t.startsWith('Explore ') || t.startsWith('1Password')) return false;
    if (/^Searching (the web|on X)$/i.test(t)) return false;
    if (/^\d+ results?$/i.test(t)) return false;
    if (/^See new posts$/i.test(t)) return false;
    if (/^\d+ (web pages?|posts?)$/i.test(t)) return false;
    if (/^[\w.-]+\.(com|org|net|gov|io|co|edu)\s*(\+\d+)?$/i.test(t)) return false;
    if (/^(Factors|Compare|Explain|Show|What|How|Why|List|Summarize|Discuss|Break down|Analyze|Impact on|Examine|Explore|Investigate|Discuss error handling strategies|Explore fallback mechanisms further)\b/i.test(t) && t.length < 120) return false;
    if (/^(Fast|Expert|Auto)$/i.test(t)) return false;
    return true;
  });
  while (cleanLines.length) {
    const head = (cleanLines[0] || '').trim();
    if (!head) { cleanLines.shift(); continue; }
    if (prompt && head.length >= 16 && head === prompt.replace(/\r/g, '').trim()) { cleanLines.shift(); continue; }
    break;
  }
  return cleanLines.join('\n').trim();
}

async function recoverGrokVisibleText(page, prompt = '') {
  return await page.evaluate((promptText) => {
    const body = document.body.innerText || '';
    let text = body;
    if (promptText) {
      const idx = body.lastIndexOf(promptText);
      if (idx >= 0) text = body.substring(idx + promptText.length);
    }
    text = text.replace(/^\s+/, '');
    return text;
  }, prompt);
}

async function findPageByUrl(browser, url) {
  if (!url) return null;
  const pages = await browser.pages();
  return pages.find((candidate) => candidate.url() === url) || null;
}

async function createGrokNetworkTracker(page) {
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  const state = {
    active: false,
    submittedAt: 0,
    requestId: null,
    url: null,
    lastDataAt: 0,
    loadingFinishedAt: 0,
    totalDataEvents: 0,
    totalDataBytes: 0,
  };

  client.on('Network.requestWillBeSent', (ev) => {
    if (!state.active) return;
    if (!ev.request?.url?.includes('https://grok.x.com/2/grok/add_response.json')) return;
    state.requestId = ev.requestId;
    state.url = ev.request.url;
  });

  client.on('Network.dataReceived', (ev) => {
    if (!state.active) return;
    if (state.requestId && ev.requestId !== state.requestId) return;
    state.lastDataAt = Date.now();
    state.totalDataEvents += 1;
    state.totalDataBytes += ev.dataLength || 0;
  });

  client.on('Network.loadingFinished', (ev) => {
    if (!state.active) return;
    if (state.requestId && ev.requestId !== state.requestId) return;
    state.loadingFinishedAt = Date.now();
  });

  return {
    markSubmitted() {
      state.active = true;
      state.submittedAt = Date.now();
      state.requestId = null;
      state.url = null;
      state.lastDataAt = 0;
      state.loadingFinishedAt = 0;
      state.totalDataEvents = 0;
      state.totalDataBytes = 0;
    },
    getState() {
      return { ...state };
    },
    async dispose() {
      try { await client.detach(); } catch {}
    },
  };
}

// ── Provider: Grok ──────────────────────────────────────────────────────────

export const grokProvider = {
  name: 'grok',
  url: 'https://x.com/i/grok',
  listModelsRequiresBrowser: true,

  async listModels({ browser, request }) {
    const page = await this.findPage({ browser, continueChat: false });
    await this.preflight({ page, request });
    const visible = await page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"]'))
      .map(el => (el.textContent || el.getAttribute('aria-label') || '').trim())
      .filter(text => /^(Auto|Fast|Expert)$/.test(text)));
    const unique = [...new Set(visible)];
    const known = [
      { id: 'auto', name: 'Auto', reasoning: 'provider-selected', visible: unique.includes('Auto') },
      { id: 'fast', name: 'Fast', reasoning: 'low-latency', visible: unique.includes('Fast') },
      { id: 'expert', name: 'Expert', reasoning: 'reasoning', visible: unique.includes('Expert') },
    ];
    return known;
  },

  async preflight({ page }) {
    return await assertGrokPageUsable({ page });
  },

  async createAttemptContext({ page }) {
    return { networkTracker: await createGrokNetworkTracker(page) };
  },

  beforeSubmit({ attemptContext }) {
    attemptContext?.networkTracker?.markSubmitted?.();
  },

  async disposeAttemptContext({ attemptContext }) {
    await attemptContext?.networkTracker?.dispose?.();
  },

  isRateLimited({ text, rawText }) {
    return isGrokQuotaMessage(`${text || ''}\n${rawText || ''}`);
  },

  isPlaceholderResponse({ text, rawText }) {
    return isGrokPlaceholderResponse({ text, rawText });
  },

  fallbackModels({ requestedModel }) {
    return getGrokFallbackModels(requestedModel);
  },

  async recoverResponse({ browser, page, result, prompt }) {
    let text = result?.text || '';
    let rawText = result?.rawText || text;
    const finalUrl = result?.finalUrl || result?.pageUrl || page.url();

    for (let recoveryAttempt = 0; recoveryAttempt < 5 && !text.trim(); recoveryAttempt++) {
      const recoveryPage = (await findPageByUrl(browser, finalUrl)) || page;
      if (recoveryAttempt > 0) await sleep(1200);
      const visibleText = await recoverGrokVisibleText(recoveryPage, prompt);
      const recoveredText = cleanRecoveredGrokText(visibleText, prompt);
      if (recoveredText.trim()) {
        text = recoveredText;
        rawText = visibleText || rawText;
        console.error('[grok] Recovered response from visible page text');
      }
    }

    return { ...result, text, rawText, finalUrl };
  },

  async findPage({ browser, continueChat }) {
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('x.com/i/grok'));
    if (!page) {
      page = pages.find(p => p.url().includes('x.com'));
      if (!page) {
        page = await browser.newPage({ background: true });
      }
    }
    if (continueChat) {
      // Find the most recently opened grok conversation tab (last in the list)
      const grokPages = pages.filter(p => p.url().includes('x.com/i/grok'));
      if (grokPages.length > 0) page = grokPages[grokPages.length - 1];
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
    } else {
      // Start a fresh Grok conversation (no conversation ID)
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
    }
    return page;
  },

  async setModel({ page, model, thinking }) {
    const nameMap = { 'default': 'Auto', 'auto': 'Auto', 'fast': 'Fast', 'expert': 'Expert', 'think': 'Expert' };
    const target = nameMap[(model || 'default').toLowerCase()] || model;

    const getCurrentModelLabel = async () => await page.evaluate(() => {
      const labels = ['Auto', 'Fast', 'Expert'];
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
        .map(el => {
          const t = (el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          return { text: t, x: r.x, y: r.y, width: r.width, height: r.height };
        })
        .filter(el => labels.includes(el.text) && el.width > 30 && el.height > 20);
      if (!candidates.length) return null;
      candidates.sort((a, b) => a.y - b.y || a.x - b.x);
      return candidates[0].text;
    });

    const current = await getCurrentModelLabel();
    if (current === target) {
      console.error(`[grok] Model VERIFIED: ${target}`);
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const opener = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
          const t = (b.textContent || '').trim();
          return t === 'Auto' || t === 'Fast' || t === 'Expert';
        });
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      if (!opener) throw new Error('[grok] Model selector button not found');

      await page.mouse.click(opener.x, opener.y);
      await sleep(1200);

      const itemPos = await page.evaluate((displayName, openerRect) => {
        const nodes = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], div, span'));
        const matches = nodes
          .map(el => {
            const t = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            return { text: t, x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          })
          .filter(el => el.text === displayName && el.width > 40 && el.height >= 16 && el.height <= 80)
          .filter(el => !(el.left >= openerRect.left && el.right <= openerRect.right && el.top >= openerRect.top && el.bottom <= openerRect.bottom))
          .sort((a, b) => Math.abs(a.y - openerRect.y) - Math.abs(b.y - openerRect.y));
        return matches[0] || null;
      }, target, opener);

      if (!itemPos) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(500);
        continue;
      }

      await page.mouse.click(itemPos.x, itemPos.y);
      await sleep(1200);

      const verified = await getCurrentModelLabel();
      if (verified === target) {
        console.error(`[grok] Model VERIFIED: ${target}`);
        return;
      }
    }

    throw new Error(`[grok] Failed to verify model selection for ${target}`);
  },

  async clearInput({ page }) {
    const taPos = await page.evaluate(() => {
      const ta = document.querySelector('textarea[placeholder="Ask anything"]');
      if (!ta) return null;
      ta.focus();
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(ta, '');
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      const r = ta.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (taPos) {
      await page.mouse.click(taPos.x, taPos.y);
      await sleep(200);
      await page.keyboard.down('Meta');
      await page.keyboard.press('a');
      await page.keyboard.up('Meta');
      await page.keyboard.press('Backspace');
      await sleep(200);
    }
  },

  async typePrompt({ page, prompt }) {
    const selector = 'textarea[placeholder="Ask anything"]';
    await page.focus(selector).catch(() => {});
    const lines = prompt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) await page.type(selector, lines[i], { delay: 0 });
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
    await sleep(800);
    let typed = await page.evaluate((expected) => {
      const ta = document.querySelector('textarea[placeholder="Ask anything"]');
      return (ta?.value || '').includes(expected.slice(0, Math.min(40, expected.length)));
    }, prompt);
    if (!typed) {
      const client = await page.createCDPSession();
      try {
        await page.focus(selector).catch(() => {});
        await client.send('Input.insertText', { text: prompt });
      } finally {
        await client.detach().catch(() => {});
      }
      await sleep(500);
      typed = await page.evaluate((expected) => {
        const ta = document.querySelector('textarea[placeholder="Ask anything"]');
        return (ta?.value || '').includes(expected.slice(0, Math.min(40, expected.length)));
      }, prompt);
    }
    if (!typed) throw new Error('[grok] Failed to type prompt into input');
  },

  async submit({ page }) {
    await sleep(500);
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const send = buttons.find(button => {
        const label = button.getAttribute('aria-label') || '';
        const rect = button.getBoundingClientRect();
        return /Grok something|Submit|Send/i.test(label) && rect.width > 10 && rect.height > 10;
      });
      if (send && !send.disabled) {
        send.click();
        return true;
      }
      return false;
    });
    if (!clicked) await page.keyboard.press('Enter');
    await sleep(3000);
  },

  async waitForResponse({ page, promptSnippet, timeoutMs, preSubmitLen = 0, existingConversationUrls = new Set(), networkTracker = null, prompt, selectedModel }) {
    const pollMs = 1000;
    const initialWait = 500;

    // Grok opens a NEW TAB for the conversation when submitting from home.
    // Detect the NEW tab (not pre-existing ones) by comparing against existingConversationUrls.
    const browser = page.browser();
    for (let tabCheck = 0; tabCheck < 8; tabCheck++) {
      await sleep(1500);
      // Check if current page navigated to a conversation
      if (page.url().includes('conversation=') && !existingConversationUrls.has(page.url())) break;
      // Check for a NEW tab (URL not in existingConversationUrls)
      const allPages = await browser.pages();
      const newConvPage = allPages.find(p => {
        const u = p.url();
        return u.includes('x.com/i/grok?conversation=') && !existingConversationUrls.has(u);
      });
      if (newConvPage) {
        page = newConvPage;
        preSubmitLen = 0;
        console.error('[grok] Switched to new conversation: ' + page.url().substring(0, 70));
        break;
      }
    }

    if (!page.url().includes('conversation=')) {
      console.error('[grok] WARNING: No new conversation tab found');
    }

    // Now wait for the response to generate
    const remainingWait = Math.max(0, initialWait - 12000);
    if (remainingWait > 0) await sleep(remainingWait);

    let prevLen = 0;
    let stableCount = 0;
    const maxPolls = Math.ceil(timeoutMs / pollMs);

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const result = await page.evaluate((cutoff, snippet, prompt) => {
        const body = document.body.innerText;
        const rateLimited = body.includes('reached your limit');

        // Prefer anchoring on the most recent prompt snippet. Numeric cutoffs are brittle in
        // continue mode because Grok can reflow the conversation and move the new answer upward.
        let searchText = body;
        if (snippet) {
          const promptIdx = body.lastIndexOf(snippet);
          if (promptIdx >= 0) searchText = body.substring(promptIdx);
          else if (cutoff > 0) searchText = body.substring(cutoff);
        } else if (cutoff > 0) {
          searchText = body.substring(cutoff);
        }

        // Strategy A: Find the LAST "Thought for" / "Thoughts" marker.
        // Strategy B: Grok auto/fast sometimes skips that marker and instead shows
        // prompt -> "Searching the web" / "Searching on X" -> answer.
        const markers = ['Thought for ', 'Thoughts\n'];
        let lastMarkerIdx = -1;
        for (const m of markers) {
          let idx = searchText.lastIndexOf(m);
          if (idx > lastMarkerIdx) lastMarkerIdx = idx;
        }

        let text = '';
        if (lastMarkerIdx >= 0) {
          text = searchText.substring(lastMarkerIdx);
        } else {
          text = searchText;
          if (prompt) {
            const normalizedPrompt = prompt.replace(/\r/g, '').trim();
            const normalizedText = text.replace(/\r/g, '');
            if (normalizedText.startsWith(normalizedPrompt)) {
              text = normalizedText.substring(normalizedPrompt.length);
            } else if (snippet) {
              const snippetIdx = text.indexOf(snippet);
              if (snippetIdx >= 0) text = text.substring(snippetIdx + snippet.length);
            }
          } else if (snippet) {
            const snippetIdx = text.indexOf(snippet);
            if (snippetIdx >= 0) text = text.substring(snippetIdx + snippet.length);
          }
          text = text.replace(/^\s+/, '');
        }
        const rawText = text;

        // Trim trailing UI elements - use the FIRST occurrence after our text
        const endMarkers = ['Ask anything', 'Dive deeper', 'Think Harder', 'Make summaries',
                           'Explain', 'Compare', 'Analyze', 'Agents\n', 'Agent\n',
                           'Expert\n1Password'];
        for (const em of endMarkers) {
          const idx = text.indexOf(em);
          if (idx > 50) text = text.substring(0, idx);
        }

        // Clean up artifacts
        const cleanLines = text.split('\n').filter(line => {
          const t = line.trim();
          if (t.length === 0) return true; // keep blank lines for formatting
          if (t.startsWith('Explore ') || t.startsWith('1Password')) return false;
          // Remove live activity/progress lines used by all Grok modes
          if (/^(Thinking about your request|Planning parallel calls|Using both keyword and semantic searches)\.?$/i.test(t)) return false;
          if (/^Searching (the web|on X)$/i.test(t)) return false;
          if (/^\d+ results?$/i.test(t)) return false;
          if (/^\d+ more$/i.test(t)) return false;
          if (/^See new posts$/i.test(t)) return false;
          // Remove trailing "N web pages" or "N posts" lines
          if (/^\d+ (web pages?|posts?)$/i.test(t)) return false;
          // Remove source domain lines like "tradingeconomics.com +1" or bare domains
          if (/^[\w.-]+\.(com|org|net|gov|io|co|edu)\s*(\+\d+)?$/i.test(t)) return false;
          // Remove suggestion chips / follow-up pills / model labels
          if (/^(Factors|Compare|Explain|Show|What|How|Why|List|Summarize|Discuss|Break down|Analyze|Impact on|Examine|Explore|Investigate)\b/i.test(t) && t.length < 120) return false;
          if (/^(Ask anything|Dive deeper|Think Harder|Make summaries|Agents?|Fast|Expert|Auto)$/i.test(t)) return false;
          return true;
        });
        while (cleanLines.length) {
          const head = (cleanLines[0] || '').trim();
          if (!head) { cleanLines.shift(); continue; }
          if (prompt && head.length >= 16 && head === prompt.replace(/\r/g, '').trim()) { cleanLines.shift(); continue; }
          break;
        }
        text = cleanLines.join('\n').trim();

        // Remove "Thought for Xs\n" prefix - keep the actual content
        text = text.replace(/^Thought for \d+[sm]\n+/i, '').replace(/^Thoughts\n+/i, '');

        return { text: text.trim(), rawText: rawText.trim(), done: rateLimited, rateLimited };
      }, preSubmitLen, promptSnippet, prompt);

      if (result.rateLimited) return { text: result.text || 'RATE_LIMITED', rawText: result.rawText || result.text || 'RATE_LIMITED', done: true, rateLimited: true, pageUrl: page.url() };

      const currentLen = result.text.length;
      const stableThreshold = selectedModel === 'expert' ? 3 : 2;
      const minAcceptLen = selectedModel === 'expert' ? 80 : 1;
      const trackerState = networkTracker?.getState?.() || null;
      const now = Date.now();
      const streamQuiet = trackerState?.lastDataAt ? (now - trackerState.lastDataAt) >= 1500 : false;
      const streamFinished = !!trackerState?.loadingFinishedAt || streamQuiet;
      const sawStream = !!trackerState?.requestId || (trackerState?.totalDataEvents || 0) > 0;
      const isPlaceholder = isGrokPlaceholderResponse({ text: result.text, rawText: result.rawText });
      const hasAcceptableText = currentLen >= minAcceptLen && !isPlaceholder;

      if (hasAcceptableText && (currentLen === prevLen || result.done)) {
        stableCount++;
      } else {
        stableCount = 0;
      }

      if (hasAcceptableText) {
        if (result.done) return { text: result.text, rawText: result.rawText, done: true, rateLimited: false, pageUrl: page.url() };
        if (sawStream && streamFinished) return { text: result.text, rawText: result.rawText, done: true, rateLimited: false, pageUrl: page.url() };
        if (stableCount >= stableThreshold && !sawStream) return { text: result.text, rawText: result.rawText, done: true, rateLimited: false, pageUrl: page.url() };
      }
      prevLen = currentLen;

      const trackerNote = trackerState
        ? ` req:${trackerState.requestId ? 'yes' : 'no'} data:${trackerState.totalDataEvents} quiet:${trackerState.lastDataAt ? now - trackerState.lastDataAt : -1}ms`
        : '';
      process.stderr.write(`  [grok] ${currentLen} chars (poll ${attempt + 1}/${maxPolls})${trackerNote}\r`);
      await sleep(pollMs);
    }
    return { text: '', rawText: '', done: false, rateLimited: false, pageUrl: page.url() };
  },
};
