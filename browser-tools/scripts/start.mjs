#!/usr/bin/env node
/**
 * Start a sandboxed Chrome instance with a synced copy of your profile.
 * Never touches or kills your main Chrome because it uses a separate user-data-dir.
 *
 * Usage:
 *   scripts/start.mjs
 *   scripts/start.mjs --profile "<Chrome profile folder>"
 *   scripts/start.mjs --profile "<Chrome profile folder>" --sync
 *   scripts/start.mjs --profile "<Chrome profile folder>" --port 9223
 *   scripts/start.mjs --headless        (run without opening a browser window)
 *   scripts/start.mjs --include-google   (keep the Google session in the clone; needed for Google workflows)
 *   BROWSER_TOOLS_OWNER_TOKEN="<owner token>" scripts/start.mjs
 */

import { CLI_OWNER_ID, hasFlag, requiredOptionValue, parseOwnerId, parseOwnerToken, parsePort, startChrome } from './browser-control.mjs';

const args = process.argv.slice(2);
const profileName = requiredOptionValue(args, '--profile', null);
const taskName = requiredOptionValue(args, '--task', null);
const forceProfileSync = hasFlag(args, '--sync');
const headless = hasFlag(args, '--headless');
const includeGoogle = hasFlag(args, '--include-google');
const explicitPort = args.includes('--port');
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);
const ownerId = parseOwnerId(args) || CLI_OWNER_ID;

try {
  const result = await startChrome({ port, profileName, taskName, forceProfileSync, autoAllocatePort: !explicitPort, ownerToken, ownerId, headless, includeGoogle });
  const mode = result.headless ? ' (headless)' : '';
  if (result.status === 'reused') {
    console.log(`✓ Chrome already running on :${result.port}${mode}; reusing owned instance`);
  } else if (result.requestedProfileName) {
    const resolved = result.profileName && result.profileName !== result.requestedProfileName ? ` resolved to "${result.profileName}"` : '';
    const task = taskName ? ` for task "${taskName}"` : '';
    console.log(`✓ Chrome ready on :${result.port}${mode} with profile "${result.requestedProfileName}"${resolved}${task}`);
  } else {
    console.log(`✓ Chrome ready on :${result.port}${mode} (fresh)`);
  }
  if (result.ownerTokenGenerated) {
    console.log(`Owner token: ${result.ownerToken}`);
    console.log(`Run: export BROWSER_TOOLS_OWNER_TOKEN="${result.ownerToken}"`);
    console.log(`Use with follow-up commands: --port ${result.port}`);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
