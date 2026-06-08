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

import { activePage, parseOwnerToken, parsePort, stripBrowserSessionArgs, withBrowser } from './browser-control.mjs';

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

  await page.evaluate(() => {
    if (window.__piPickerInstalled) return;
    window.__piPickerInstalled = true;

    window.pick = (message) =>
      new Promise((resolve) => {
        const selections = [];
        const selectedEls = new Set();

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

        const info = (el) => {
          const parents = [];
          let cur = el.parentElement;
          while (cur && cur !== document.body) {
            const tag = cur.tagName.toLowerCase();
            const id = cur.id ? `#${cur.id}` : '';
            const cls = cur.className ? `.${cur.className.trim().split(/\s+/).join('.')}` : '';
            parents.push(tag + id + cls);
            cur = cur.parentElement;
          }
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            class: el.className || null,
            text: el.textContent?.trim().slice(0, 200) || null,
            html: el.outerHTML.slice(0, 500),
            parents: parents.join(' > '),
          };
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

          if (e.metaKey || e.ctrlKey) {
            if (!selectedEls.has(el)) {
              selectedEls.add(el);
              el.style.outline = '3px solid #10b981';
              selections.push(info(el));
              refresh();
            }
          } else {
            cleanup();
            resolve(selections.length > 0 ? selections : info(el));
          }
        };

        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cleanup();
            resolve(null);
          }
          if (e.key === 'Enter' && selections.length > 0) {
            e.preventDefault();
            cleanup();
            resolve(selections);
          }
        };

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
      });
  });

  const result = await page.evaluate((msg) => window.pick(msg), message);
  printResult(result);
}, { ownerToken });

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
