#!/usr/bin/env node
/**
 * Execute JavaScript in the active tab's page context.
 * Runs in an async context, so you can use await.
 *
 * Usage:
 *   scripts/eval.mjs 'document.title'
 *   scripts/eval.mjs 'await fetch("/api/data").then(r => r.json())'
 *   scripts/eval.mjs --port 9223 'document.title'
 *   scripts/eval.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN" 'document.title'
 */

import { activePage, parseOwnerToken, parsePort, stripBrowserSessionArgs, withBrowser } from './browser-control.mjs';

const args = process.argv.slice(2);
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);
const code = stripBrowserSessionArgs(args).join(' ');

if (!code) {
  console.log("Usage: eval.js [--port <n>] '<javascript>'");
  console.log("  ./eval.js 'document.title'");
  console.log('  ./eval.js \'document.querySelectorAll("a").length\'');
  process.exit(1);
}

await withBrowser(port, async (browser) => {
  const page = await activePage(browser);
  const result = await page.evaluate((c) => {
    const AsyncFunction = (async () => {}).constructor;
    return new AsyncFunction(`return (${c})`)();
  }, code);

  printResult(result);
}, { ownerToken });

function printResult(result) {
  if (Array.isArray(result)) {
    result.forEach((item, i) => {
      if (i > 0) console.log('');
      printResult(item);
    });
    return;
  }

  if (typeof result === 'object' && result !== null) {
    for (const [k, v] of Object.entries(result)) console.log(`${k}: ${v}`);
    return;
  }

  console.log(result);
}
