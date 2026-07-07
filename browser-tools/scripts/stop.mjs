#!/usr/bin/env node
/**
 * Stop the sandboxed Chrome instance started by start.mjs.
 * Only kills the PID we spawned, never the main Chrome process.
 *
 * Usage:
 *   scripts/stop.mjs
 *   scripts/stop.mjs --port 9223
 *   scripts/stop.mjs --clean
 *   scripts/stop.mjs --dry-run
 *   scripts/stop.mjs --prune            (remove all cached clones not in use)
 *   scripts/stop.mjs --owner-token "$BROWSER_TOOLS_OWNER_TOKEN"
 */

import { hasFlag, parseOwnerToken, parsePort, pruneChromeClones, stopChrome } from './browser-control.mjs';

const args = process.argv.slice(2);
const port = parsePort(args);
const clean = hasFlag(args, '--clean');
const dryRun = hasFlag(args, '--dry-run');
const ownerToken = parseOwnerToken(args);

if (hasFlag(args, '--prune')) {
  const prune = pruneChromeClones({ dryRun });
  if (!prune.removed.length && !prune.kept.length) {
    console.log('No cached Chrome clones found.');
  }
  for (const entry of prune.kept) {
    console.log(`• Keeping :${entry.port} (in use by PID ${entry.pid})`);
  }
  for (const entry of prune.removed) {
    const count = entry.paths.length;
    console.log(`${dryRun ? '• Would remove' : '✓ Removed'} clone for :${entry.port} (${count} item${count === 1 ? '' : 's'})`);
  }
  process.exit(0);
}

const result = stopChrome({ port, clean, dryRun, ownerToken });

if (result.status === 'missing') {
  console.log(`No managed debug Chrome instance found for port ${port}`);
  process.exit(0);
}

if (result.status === 'would-stop') {
  console.log(`✓ Dry run: would stop managed Chrome (PID ${result.pid}) on :${port}`);
} else if (result.status === 'stopped') {
  console.log(`✓ Stopped managed Chrome (PID ${result.pid}) on :${port}`);
} else if (result.status === 'killed') {
  console.log(`✓ Killed managed Chrome (PID ${result.pid}) on :${port} after SIGTERM did not exit`);
} else if (result.status === 'already-gone') {
  console.log(`✓ Managed Chrome (PID ${result.pid}) was already gone`);
} else if (result.status === 'not-managed') {
  const target = result.pid ? `PID ${result.pid}` : `port ${port}`;
  console.error(`✗ Refusing to stop ${target}: ${result.reason}`);
  console.error('  Safety rule: stop.mjs only kills Chrome processes launched by start.mjs.');
  process.exit(1);
} else if (result.status === 'not-owned') {
  const owner = result.ownerId ? ` owned by ${result.ownerId}` : '';
  console.error(`✗ Refusing to stop managed Chrome on :${port}${owner}: ${result.reason}`);
  console.error('  Safety rule: provide the same --owner-token that start.mjs printed for this browser.');
  process.exit(1);
} else if (result.status === 'locked') {
  console.error(`✗ Refusing to stop managed Chrome on :${port}: ${result.reason}`);
  console.error('  A start operation is still claiming this port. Retry after it finishes.');
  process.exit(1);
} else {
  console.error(`✗ Failed to stop Chrome: ${result.error?.message || 'unknown error'}`);
}

if (result.cleaned) console.log('✓ Cleaned up cached profile copy');
