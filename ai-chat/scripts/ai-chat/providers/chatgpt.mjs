import { sleep } from './shared.mjs';

export const chatgptProvider = {
  name: 'chatgpt',
  url: 'https://chatgpt.com',
  listModelsRequiresBrowser: true,

  async listModels({ browser }) {
    const page = await this.findPage({ browser, continueChat: false });
    const headerPos = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find(b => /^(Instant|Thinking|Pro|Research)\b/i.test((b.textContent || '').trim()))
        || buttons.find(b => b.textContent?.trim() === 'ChatGPT');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!headerPos) return [];
    await page.mouse.click(headerPos.x, headerPos.y);
    await sleep(1000);
    const labels = await page.evaluate(() => {
      const candidates = [];
      for (const el of document.querySelectorAll('[role="menuitem"], [cmdk-item], button, div')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        if (!text || text.length > 80 || rect.height < 12 || rect.height > 80 || rect.x < 250 || rect.y < 250 || rect.y > 760) continue;
        if (/^(Instant|Thinking|Pro|Research|Temporary chat)$/i.test(text) || /^(GPT|ChatGPT|Thinking|Instant|Pro|Research)\b/i.test(text)) {
          candidates.push(text);
        }
      }
      return [...new Set(candidates)].slice(0, 50);
    });
    await page.keyboard.press('Escape').catch(() => {});
    return labels.map(label => ({ id: label.toLowerCase().replace(/\s+/g, '-'), name: label, visible: true, account_specific: true }));
  },

  async findPage({ browser, continueChat }) {
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('chatgpt.com'));
    if (!page) {
      page = await browser.newPage({ background: true });
    }
    if (continueChat && page.url().includes('chatgpt.com/c/')) {
      // Continue existing conversation
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2000);
    } else {
      // Fresh conversation
      await page.goto(this.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);
    }
    return page;
  },

  async setModel({ page, model, thinking }) {
    // Parse flags
    let actualModel = model;
    let enableTemp = model.toLowerCase().includes('temporary') || model.toLowerCase().includes('temp');
    if (enableTemp) actualModel = model.replace(/\s*(temporary|temp)/gi, '').trim();
    if (!actualModel || actualModel === 'default') actualModel = 'thinking'; // default to thinking

    const modelMap = {
      'instant': 'Instant', 'fast': 'Instant',
      'thinking': 'Thinking', 'think': 'Thinking',
      'pro': 'Pro', 'research': 'Pro',
    };
    const displayName = modelMap[actualModel.toLowerCase()] || actualModel;

    // Step 1: Open the ChatGPT ▼ dropdown
    const headerPos = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'ChatGPT');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!headerPos) { console.error('[chatgpt] Header button not found'); return; }
    await page.mouse.click(headerPos.x, headerPos.y);
    await sleep(1500);

    // Step 2: Click the target model
    const itemPos = await page.evaluate((target) => {
      for (const el of document.querySelectorAll('*')) {
        const t = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        if (t === target && r.height >= 15 && r.height <= 30 && r.y > 50 && r.y < 300) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, displayName);

    if (itemPos) {
      await page.mouse.click(itemPos.x, itemPos.y);
      await sleep(1000);
    } else {
      console.error('[chatgpt] Model not found: ' + displayName);
      await page.keyboard.press('Escape');
      await sleep(500);
    }

    // Step 3: VERIFY - reopen dropdown to check checkmark
    await page.mouse.click(headerPos.x, headerPos.y);
    await sleep(1000);
    const verified = await page.evaluate((target) => {
      // Look for the target model text that has an SVG sibling (checkmark)
      for (const el of document.querySelectorAll('*')) {
        const t = (el.textContent || '').trim();
        if (t === target && el.getBoundingClientRect().height > 10 && el.getBoundingClientRect().height < 30) {
          const parent = el.parentElement;
          if (parent && parent.querySelector('svg')) return true;
        }
      }
      return false;
    }, displayName);
    await page.keyboard.press('Escape');
    await sleep(500);

    if (verified) {
      console.error('[chatgpt] Model VERIFIED: ' + displayName);
    } else {
      console.error('[chatgpt] WARNING: Could not verify model ' + displayName + ' is selected');
    }

    // Step 4: Handle temporary chat
    if (enableTemp) {
      const tempBtn = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          (b.getAttribute('aria-label') || '').includes('temporary chat'));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2,
                 isOn: btn.getAttribute('aria-label')?.includes('Turn off') };
      });
      if (tempBtn && !tempBtn.isOn) {
        await page.mouse.click(tempBtn.x, tempBtn.y);
        await sleep(1000);
        console.error('[chatgpt] Temporary chat: enabled');
      }
    }
  },

  async clearInput({ page }) {
    // Click the input to focus, then Cmd+A + Backspace
    const inputPos = await page.evaluate(() => {
      const el = document.getElementById('prompt-textarea');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (inputPos) {
      await page.mouse.click(inputPos.x, inputPos.y);
      await sleep(200);
      await page.keyboard.down('Meta');
      await page.keyboard.press('a');
      await page.keyboard.up('Meta');
      await page.keyboard.press('Backspace');
      await sleep(200);
    }
  },

  async typePrompt({ page, prompt }) {
    // Click input first to ensure focus
    const inputPos = await page.evaluate(() => {
      const el = document.getElementById('prompt-textarea');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (inputPos) {
      await page.mouse.click(inputPos.x, inputPos.y);
      await sleep(300);
    }
    // CRITICAL: In ChatGPT, Enter = send message.
    // Must use Shift+Enter for newlines within the message.
    const lines = prompt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        await page.keyboard.type(lines[i], { delay: 0 });
      }
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
    await sleep(800);
  },

  async submit({ page }) {
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(2000);
  },

  async waitForResponse({ page, promptSnippet, timeoutMs, preSubmitLen = 0, selectedModel }) {
    const pollMs = 2000;
    const isThinking = selectedModel.toLowerCase().includes('think');
    // Wait for thinking to start before polling
    const initialWait = isThinking ? 8000 : 3000;
    await sleep(initialWait);

    // Count assistant messages BEFORE the response starts to know which one is new
    const msgCountBefore = await page.evaluate(() =>
      document.querySelectorAll('[data-message-author-role="assistant"]').length
    ).catch(() => 0);

    let prevLen = 0;
    let stableCount = 0;
    let hasGrown = false;
    const stableThreshold = isThinking ? 8 : 4; // 16s / 8s of stability
    const minResponseLen = isThinking ? 1000 : 200; // thinking models need higher min - the "thought preview" is usually <500 chars
    const maxPolls = Math.ceil(timeoutMs / pollMs);

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const result = await page.evaluate((beforeCount, minLen) => {
        // Strategy: extract the LAST assistant message using ChatGPT's data attributes
        const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (msgs.length === 0) return { text: '', done: false, generating: true };

        // Get the last assistant message (the new response)
        const lastMsg = msgs[msgs.length - 1];
        let text = lastMsg.innerText || '';

        // Clean up "Thought for Xs" prefix
        text = text.replace(/^Thought for \d+[sm]?\s*\n?/i, '');
        text = text.replace(/^ChatGPT said\s*\n?/i, '');

        // Remove inline source citations like "arxiv +1" "Cohere Documentation +2"
        var lines = text.split('\n').filter(function(line) {
          var t = line.trim();
          // Remove bare citation lines: "arxiv", "arxiv +1", "Cohere Documentation +2"
          if (/^[\w\s.-]+(\.\w+)?\s*\+\d+$/i.test(t)) return false;
          // Remove bare domain/source lines
          if (/^(arxiv|github|wikipedia|Cohere|Hugging Face|Pinecone|Elastic|Jina|OpenAI|Microsoft|Google|ACM|ACL|Bloomberg)\b/i.test(t) && t.length < 60) return false;
          return true;
        });
        text = lines.join('\n').trim();

        // Check if still generating
        var isGenerating = !!document.querySelector('[aria-label="Stop generating"]') ||
                          !!document.querySelector('[data-testid="stop-button"]');

        // Also check if a new message appeared vs before
        var newMsg = msgs.length > beforeCount;

        return { text: text, done: text.length > minLen && !isGenerating && newMsg, generating: isGenerating, msgCount: msgs.length };
      }, msgCountBefore, minResponseLen).catch(() => ({ text: '', done: false, generating: true }));

      const currentLen = result.text.length;

      if (currentLen > prevLen) {
        hasGrown = true;
        stableCount = 0;
      } else if (currentLen > 0 && currentLen === prevLen && hasGrown && currentLen >= minResponseLen) {
        stableCount++;
      } else {
        stableCount = 0;
      }

      // Done conditions (in priority order):
      // 1. Not generating + has substantial content + content has grown and stabilized
      if (result.done && stableCount >= 2) {
        console.error(`\n[chatgpt] Response complete: ${currentLen} chars`);
        return { text: result.text, done: true };
      }
      // 2. Content stable for threshold polls + not generating
      if (hasGrown && currentLen >= minResponseLen && !result.generating && stableCount >= stableThreshold) {
        console.error(`\n[chatgpt] Response stable: ${currentLen} chars (${stableCount} polls)`);
        return { text: result.text, done: true };
      }
      // 3. Content stable for extended threshold even if generating flag stuck
      if (hasGrown && currentLen >= minResponseLen && stableCount >= stableThreshold + 3) {
        console.error(`\n[chatgpt] Response forced stable: ${currentLen} chars (${stableCount} polls, generating=${result.generating})`);
        return { text: result.text, done: true };
      }

      prevLen = currentLen;
      process.stderr.write(`  [chatgpt] ${currentLen} chars (poll ${attempt + 1}/${maxPolls})${result.generating ? ' ⏳' : ''}\r`);
      await sleep(pollMs);
    }

    // Timeout - extract whatever we have
    const finalResult = await page.evaluate(() => {
      var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (msgs.length === 0) return { text: '', done: false };
      var text = msgs[msgs.length - 1].innerText || '';
      text = text.replace(/^Thought for \d+[sm]?\s*\n?/i, '');
      text = text.replace(/^ChatGPT said\s*\n?/i, '');
      return { text: text.trim(), done: true };
    }).catch(() => ({ text: '', done: false }));

    console.error(`\n[chatgpt] Timeout - extracted ${finalResult.text.length} chars`);
    return finalResult;
  },
};
