#!/usr/bin/env node
/**
 * Interactive DOM element picker. Lets you click elements in Chrome
 * and get back their tag, id, class, text, html, and parent chain.
 * Useful for pinpointing selectors without guessing at the DOM structure.
 *
 * Usage:
 *   scripts/pick.mjs "Click the price element"
 *   scripts/pick.mjs --port 9223 "Select the nav links"
 *   scripts/pick.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN" "Select the nav links"
 *
 * Controls in the browser:
 *   Click: select single element and finish
 *   Cmd/Ctrl+Click: add to multi-selection
 *   Enter: finish with multi-selection
 *   Esc: cancel
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { activePage, parseOwnerToken, parsePort, stripBrowserSessionArgs, withBrowser } from './browser-control.mjs';

if (isDirectExecution()) await main();

async function main() {
  const args = process.argv.slice(2);
  const port = parsePort(args);
  const ownerToken = parseOwnerToken(args);
  const message = stripBrowserSessionArgs(args).join(' ');

  if (!message) {
    console.log("Usage: pick.js [--port <n>] '<instruction>'");
    console.log('  ./pick.js "Click the submit button"');
    process.exit(1);
  }

  await withBrowser(port, async (browser) => {
    const page = await activePage(browser);

    await page.evaluate(installPicker);

    const result = await page.evaluate((msg) => window.pick(msg), message);
    printResult(result);
  }, { ownerToken });
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

export function installPicker() {
  if (window.__piPickerInstalled) return;
  window.__piPickerInstalled = true;

  const normalizeClassValue = (el) => {
    const value = typeof el.className === 'string'
      ? el.className
      : typeof el.getAttribute === 'function'
        ? el.getAttribute('class')
        : '';
    return typeof value === 'string' ? value.trim().split(/\s+/).filter(Boolean).join(' ') : '';
  };

  const selectorClass = (el) => {
    const value = normalizeClassValue(el);
    return value ? `.${value.split(/\s+/).join('.')}` : '';
  };

  const info = (el) => {
    const parents = [];
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      const id = cur.id ? `#${cur.id}` : '';
      parents.push(tag + id + selectorClass(cur));
      cur = cur.parentElement;
    }

    const className = normalizeClassValue(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: className || null,
      text: el.textContent?.trim().slice(0, 200) || null,
      html: el.outerHTML.slice(0, 500),
      parents: parents.join(' > '),
    };
  };

  const errorMessage = (error) => {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return String(error);
  };

  window.pick = (message) =>
    new Promise((resolve, reject) => {
      const selections = [];
      const selectedEls = new Set();
      let settled = false;

      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none';

      const highlight = document.createElement('div');
      highlight.style.cssText =
        'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s;pointer-events:none';
      overlay.appendChild(highlight);

      const banner = document.createElement('div');
      banner.style.cssText =
        'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;' +
        'padding:12px 24px;border-radius:8px;font:14px/1.4 sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.4);' +
        'pointer-events:auto;z-index:2147483647;white-space:nowrap';

      const refresh = () => {
        banner.textContent = `${message}  |  ${selections.length} selected  |  Cmd+click multi  |  Enter finish  |  Esc cancel`;
      };
      refresh();
      document.body.append(banner, overlay);

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        banner.remove();
        selectedEls.forEach((el) => (el.style.outline = ''));
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Picker failed to extract element info: ${errorMessage(error)}`));
      };

      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || overlay.contains(el) || banner.contains(el)) return;
        const r = el.getBoundingClientRect();
        Object.assign(highlight.style, {
          top: `${r.top}px`,
          left: `${r.left}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      };

      const onClick = (e) => {
        if (banner.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || overlay.contains(el) || banner.contains(el)) return;

        try {
          if (e.metaKey || e.ctrlKey) {
            if (!selectedEls.has(el)) {
              selectedEls.add(el);
              el.style.outline = '3px solid #10b981';
              selections.push(info(el));
              refresh();
            }
          } else {
            finish(selections.length > 0 ? selections : info(el));
          }
        } catch (error) {
          fail(error);
        }
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
        if (e.key === 'Enter' && selections.length > 0) {
          e.preventDefault();
          finish(selections);
        }
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
}

function printResult(result) {
  if (result === null) {
    console.log('(cancelled)');
    return;
  }

  if (Array.isArray(result)) {
    result.forEach((item, i) => {
      if (i > 0) console.log('');
      for (const [k, v] of Object.entries(item)) console.log(`${k}: ${v}`);
    });
    return;
  }

  for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`);
}
