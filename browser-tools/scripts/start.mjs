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
 *   scripts/start.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import { hasFlag, optionValue, parseOwnerId, parseOwnerToken, parsePort, startChrome } from './browser-control.mjs';

const args = process.argv.slice(2);
const profileName = optionValue(args, '--profile', null);
const taskName = optionValue(args, '--task', null);
const forceProfileSync = hasFlag(args, '--sync');
const explicitPort = args.includes('--port');
const port = parsePort(args);
const ownerToken = parseOwnerToken(args);
const ownerId = parseOwnerId(args);

try {
  const result = await startChrome({ port, profileName, taskName, forceProfileSync, autoAllocatePort: !explicitPort, ownerToken, ownerId });
  if (result.status === 'reused') {
    console.log(`✓ Chrome already running on :${result.port}; reusing owned instance`);
  } else if (result.requestedProfileName) {
    const resolved = result.profileName && result.profileName !== result.requestedProfileName ? ` resolved to "${result.profileName}"` : '';
    const task = taskName ? ` for task "${taskName}"` : '';
    console.log(`✓ Chrome ready on :${result.port} with profile "${result.requestedProfileName}"${resolved}${task}`);
  } else {
    console.log(`✓ Chrome ready on :${result.port} (fresh)`);
  }
  if (result.ownerTokenGenerated) {
    console.log(`Owner token: ${result.ownerToken}`);
    console.log(`Use with follow-up commands: --port ${result.port} --owner-token ${result.ownerToken}`);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
