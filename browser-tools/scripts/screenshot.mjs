#!/usr/bin/env node
/**
 * Take a screenshot of the active tab's viewport.
 * Prints the file path so the agent can read it.
 *
 * Usage:
 *   scripts/screenshot.mjs
 *   scripts/screenshot.mjs --port 9223
 *   scripts/screenshot.mjs --full
 *   scripts/screenshot.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import { activePage, hasFlag, parseOwnerToken, parsePort, timestampedTmpPath, withBrowser } from './browser-control.mjs';

const args = process.argv.slice(2);
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);
const fullPage = hasFlag(args, '--full');

await withBrowser(port, async (browser) => {
  const page = await activePage(browser);
  const filepath = timestampedTmpPath('browser-screenshot', 'png');
  await page.screenshot({ path: filepath, fullPage });
  console.log(filepath);
}, { ownerToken });
