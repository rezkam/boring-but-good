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

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { activePage, parseOwnerToken, parsePort, stripBrowserSessionArgs, withBrowser } from './browser-control.mjs';

if (isDirectExecution()) await main();

async function main() {
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
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

export function formatResultLines(result) {
  if (Array.isArray(result)) {
    return result.flatMap((item, i) => {
      const lines = formatResultLines(item);
      return i > 0 ? ['', ...lines] : lines;
    });
  }

  if (typeof result === 'object' && result !== null) {
    return Object.entries(result).map(([k, v]) => `${k}: ${formatNestedValue(v)}`);
  }

  return [formatPrimitiveValue(result)];
}

function printResult(result) {
  for (const line of formatResultLines(result)) console.log(line);
}

function formatNestedValue(value) {
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      return format('%s', value);
    }
  }

  return formatPrimitiveValue(value);
}

function formatPrimitiveValue(value) {
  return format('%s', value);
}
